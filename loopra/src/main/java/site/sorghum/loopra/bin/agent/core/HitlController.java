package site.sorghum.loopra.bin.agent.core;

import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.ONode;
import org.noear.solon.ai.chat.tool.ToolCall;
import site.sorghum.cutin.core.context.DefaultLoopContext;
import site.sorghum.cutin.core.loop.LoopHandle;
import site.sorghum.cutin.core.loop.LoopResult;
import site.sorghum.cutin.core.loop.ReentryRequest;
import site.sorghum.cutin.core.model.ModelResponse;
import site.sorghum.cutin.core.state.LoopSnapshot;
import site.sorghum.loopra.bin.agent.context.MessageHealer;
import site.sorghum.loopra.bin.agent.hitl.HitlManager;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.model.HitlState;
import site.sorghum.loopra.bin.agent.model.ToolCallEntry;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.bin.model.UserMessageSanitizer;
import site.sorghum.loopra.integration.cutin.plugin.preflight.LoopraPreflight;
import site.sorghum.loopra.integration.cutin.plugin.preflight.LoopraPreflightHost;
import site.sorghum.loopra.tool.LogLevel;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * HITL（人工审批）宿主。
 * <p>负责 preflight 消息清洗/注入、cutin 挂起态的保存与恢复（含沙箱越界审批）、
 * AFTER_MODEL 的 HITL 拦截，以及 AI 工具调用校验器兜底判定。</p>
 */
@Slf4j
final class HitlController implements LoopraPreflightHost {

    private final AgentLoop loop;

    /** cutin 挂起态：HITL 暂停时保留 handle/context/state 供批准后续跑。 */
    private volatile LoopHandle suspendedCutinHandle;
    private volatile DefaultLoopContext suspendedCutinContext;
    private volatile AgentLoop.LoopState suspendedCutinState;

    /** AI 工具调用校验器（tool-call-validator），不通过时回退人工审批。 */
    private volatile ToolCallValidator toolCallValidator;

    HitlController(AgentLoop loop) {
        this.loop = loop;
    }

    void toolCallValidator(ToolCallValidator validator) {
        this.toolCallValidator = Objects.requireNonNull(validator, "toolCallValidator must not be null");
    }

    @Override
    public UserMessage sanitizePreflightMessage(UserMessage message) {
        return UserMessageSanitizer.sanitize(message, loop.getModelProvider(), loop.workingDirectory());
    }

    @Override
    public void appendPreflightUserMessage(UserMessage message) {
        loop.ctx().addUser(message);
    }

    @Override
    public void clearSuspendedCutinState() {
        suspendedCutinHandle = null;
        suspendedCutinContext = null;
        suspendedCutinState = null;
    }

    @Override
    public HitlState hitlState() {
        return loop.getHitlManager().getState();
    }

    @Override
    public boolean hasSuspendedCutin() {
        return suspendedCutinHandle != null && suspendedCutinContext != null;
    }

    @Override
    public boolean hasSandboxPending() {
        return loop.getHitlManager().hasSandboxPending();
    }

    @Override
    public String resumeApprovedTurn() throws IOException {
        return loop.getHitlManager().hasSandboxPending()
            ? resumeCutinSandboxHITL()
            : resumeCutinHITL();
    }

    @Override
    public String rejectTurn() {
        return loop.getHitlManager().hasSandboxPending()
            ? denyCutinSandboxHITL()
            : denyCutinHITL();
    }

    String suspendSandboxHITLIfPending(DefaultLoopContext context) {
        HitlManager hitlManager = loop.getHitlManager();
        if (hitlManager.getState() != HitlState.PENDING || !hitlManager.hasSandboxPending()) {
            return null;
        }
        Object resumeState = context.artifacts().get("loopraSandboxResume");
        if (resumeState instanceof HitlManager.PendingSandboxState sandboxState) {
            hitlManager.storeSandboxContent(sandboxState.content(), sandboxState.reasoningContent());
        } else if (context.artifacts().get("loopraModel") instanceof CutinStreamSnapshot snapshot) {
            hitlManager.storeSandboxContent(snapshot.content(), snapshot.reasoningContent());
        }
        return hitlManager.interceptForSandboxHITL(loop.getOutput());
    }

    /**
     * cutin AFTER_MODEL 使用的 HITL 入口。返回非空文本时表示循环应暂停，
     * 文本即向用户展示的审批提示。
     */
    String interceptHITLFromCutin(ModelResponse response) {
        if (response == null || response.message() == null) {
            return null;
        }
        ONode toolCalls = CutinStreamSupport.toolCallsFromCutinMessage(response.message());
        if (toolCalls == null || !toolCalls.isArray() || toolCalls.getArray().isEmpty()) {
            return null;
        }
        // HITL 暂存的响应稍后会在独立的 tool 节点重放；先按当前历史归一化，
        // 避免审批期间把模型重放的旧 call_id 原样带入 provider。
        toolCalls = MessageHealer.normalizeIncomingToolCallIds(
                toolCalls, loop.messagesForToolCallNormalization());
        String content = response.message().content();
        String reasoning = CutinStreamSupport.metadataString(response.message(), "reasoning_content");
        HitlManager hitlManager = loop.getHitlManager();
        if (!hitlManager.isHitlMode() || !hitlManager.requiresHITL(toolCalls)) {
            return null;
        }

        if (toolCallValidator.enabled()) {
            ToolCallValidator.Decision decision = validateHITLToolCalls(toolCalls);
            if (decision.requiresHuman()) {
                hitlManager.setSandboxPending(toolCalls, decision.reason());
                hitlManager.storeSandboxContent(content, reasoning);
                return hitlManager.interceptForSandboxHITL(loop.getOutput());
            }
            if (decision.failed()) {
                loop.safeOutput("toolValidator", () -> loop.getOutput().onLog(LogLevel.WARN,
                        "[tool-validator] " + decision.reason() + "，回退人工审批"));
                String hitlPrompt = hitlManager.interceptForHITL(
                        toolCalls, content, reasoning, loop.getOutput());
                return hitlPrompt;
            }
            if (!decision.allowed()) {
                String denyMsg = "工具调用未通过 AI 审批: " + decision.reason();
                loop.safeOutput("toolValidator", () -> loop.getOutput().onLog(LogLevel.WARN,
                        "[tool-validator] " + denyMsg));
                loop.ctx().addAssistant(denyMsg, null, null);
                return denyMsg;
            }
            loop.safeOutput("toolValidator", () -> loop.getOutput().onLog(LogLevel.INFO,
                    "[tool-validator] AI 审批通过，继续执行工具调用"));
            return null;
        }
        return hitlManager.interceptForHITL(toolCalls, content, reasoning, loop.getOutput());
    }

    ToolCallValidator.Decision validateHITLToolCalls(ONode toolCalls) {
        if (toolCalls == null || !toolCalls.isArray()) {
            return ToolCallValidator.Decision.deny("工具调用格式无效");
        }
        for (ONode node : toolCalls.getArray()) {
            ToolCall toolCall = CutinStreamSupport.getToolCall(node);
            if (toolCall.getName() == null || toolCall.getName().isBlank()) {
                return ToolCallValidator.Decision.deny("工具名称为空");
            }
            ToolCallValidator.Decision decision = toolCallValidator.validate(
                    toolCall.getName(), ONode.ofBean(toolCall.getArguments()).toJson());
            if (decision.requiresHuman()) {
                return ToolCallValidator.Decision.requireHuman(
                        toolCall.getName() + ": " + decision.reason());
            }
            if (decision.failed()) {
                return ToolCallValidator.Decision.failed(
                        toolCall.getName() + ": " + decision.reason());
            }
            if (!decision.allowed()) {
                return ToolCallValidator.Decision.deny(toolCall.getName() + ": " + decision.reason());
            }
        }
        return ToolCallValidator.Decision.allow();
    }

    /**
     * 收口 cutin 运行结果：抛业务错误、还原暂停态、返回回合文本。
     */
    String finishCutinResult(AgentLoop.LoopState state, DefaultLoopContext cutinContext,
                             LoopHandle handle, LoopResult result) throws IOException {
        if (state.ioError != null) {
            throw state.ioError;
        }
        Object turnError = cutinContext.artifacts().get(LoopraPreflight.ERROR_ARTIFACT);
        if (turnError instanceof IOException exception) {
            throw exception;
        }
        if (state.result != null) {
            return state.result;
        }
        Map<String, Object> finalVariables = result.finalSnapshot() == null
                ? cutinContext.variables()
                : result.finalSnapshot().variables();
        Object turnResult = finalVariables.get(LoopraPreflight.RESULT_VARIABLE);
        String turnContent = turnResult == null ? "" : String.valueOf(turnResult);
        if (!turnContent.isBlank()) {
            return turnContent;
        }
        if (result.status() == LoopResult.Status.COMPLETED
                || result.status() == LoopResult.Status.CANCELLED
                || result.status() == LoopResult.Status.ABORTED) {
            String last = loop.ctx().getLastAssistantContent();
            return last != null && !last.isEmpty() ? last : "⏹️ 已停止生成";
        }
        if (result.status() == LoopResult.Status.SUSPENDED) {
            suspendedCutinHandle = handle;
            // reenter 从快照创建新 context，传入的 cutinContext 可能仍是上一轮对象。
            // 必须保存本次暂停的最新变量/产物，否则第二次批准会重放第一次的工具。
            suspendedCutinContext = result.finalSnapshot() == null
                    ? cutinContext
                    : loop.cutinEngine().restore(result.finalSnapshot());
            suspendedCutinState = state;
            return result.message() != null && !result.message().isBlank()
                    ? result.message()
                    : "⏸️ 已暂停，等待外部输入";
        }
        throw new IOException("[loop] cutin loop failed: " + result.message());
    }

    private String resumeCutinHITL() throws IOException {
        HitlManager hitlManager = loop.getHitlManager();
        hitlManager.drainPendingHITL();
        hitlManager.resetState();
        LoopHandle handle = suspendedCutinHandle;
        DefaultLoopContext context = suspendedCutinContext;
        AgentLoop.LoopState state = suspendedCutinState;
        suspendedCutinHandle = null;
        suspendedCutinContext = null;
        suspendedCutinState = null;
        if (handle == null || context == null || state == null) {
            throw new IOException("[loop] cutin HITL 恢复状态丢失");
        }
        Object raw = context.variables().get("loopraPendingModelResponse");
        if (!(raw instanceof ModelResponse response)) {
            throw new IOException("[loop] cutin HITL 未找到待审批模型响应");
        }
        CutinStreamSnapshot snapshot = CutinStreamSupport.cutinSnapshotFromResponse(response);
        LoopSnapshot base = handle.snapshot();
        ReentryRequest request = new ReentryRequest(
                "tool",
                base.stateVersion(),
                Map.of(),
                Map.of("loopraModel", snapshot),
                "hitl-approved");
        loop.activeCutinHandle(handle);
        try {
            LoopResult result = handle.reenter(request).join();
            return finishCutinResult(state, context, handle, result);
        } finally {
            loop.activeCutinHandle(null);
        }
    }

    private String denyCutinHITL() {
        HitlManager hitlManager = loop.getHitlManager();
        hitlManager.drainPendingHITL();
        hitlManager.resetState();
        suspendedCutinHandle = null;
        suspendedCutinContext = null;
        suspendedCutinState = null;
        loop.turnExitController().discardFinishRequest();
        String denyMsg = "工具调用已被用户拒绝。";
        loop.ctx().addAssistant(denyMsg, null, null);
        return denyMsg;
    }

    private String resumeCutinSandboxHITL() throws IOException {
        HitlManager hitlManager = loop.getHitlManager();
        HitlManager.PendingSandboxState sandboxState = hitlManager.drainSandboxHITL();
        hitlManager.resetState();
        LoopHandle handle = suspendedCutinHandle;
        DefaultLoopContext context = suspendedCutinContext;
        AgentLoop.LoopState state = suspendedCutinState;
        suspendedCutinHandle = null;
        suspendedCutinContext = null;
        suspendedCutinState = null;
        if (handle == null || context == null || state == null
                || sandboxState == null || sandboxState.toolCalls() == null) {
            throw new IOException("[loop] cutin 沙箱 HITL 恢复状态丢失");
        }
        LoopSnapshot base = handle.snapshot();
        if (base == null) {
            throw new IOException("[loop] cutin 沙箱 HITL 检查点丢失");
        }
        ReentryRequest request = new ReentryRequest(
                "tool",
                base.stateVersion(),
                Map.of("loopraSandboxApproved", Boolean.TRUE),
                Map.of("loopraSandboxResume", sandboxState),
                "sandbox-hitl-approved");
        loop.activeCutinHandle(handle);
        try {
            LoopResult result = handle.reenter(request).join();
            return finishCutinResult(state, context, handle, result);
        } finally {
            loop.activeCutinHandle(null);
        }
    }

    private String denyCutinSandboxHITL() {
        HitlManager hitlManager = loop.getHitlManager();
        HitlManager.PendingSandboxState sandboxState = hitlManager.drainSandboxHITL();
        hitlManager.resetState();
        suspendedCutinHandle = null;
        suspendedCutinContext = null;
        suspendedCutinState = null;
        loop.turnExitController().discardFinishRequest();
        if (sandboxState != null) {
            ONode normalizedToolCalls = MessageHealer.normalizeIncomingToolCallIds(
                    sandboxState.toolCalls(), loop.messagesForToolCallNormalization());
            List<ToolCallEntry> tcList = CutinStreamSupport.parseToolCallsFromONode(normalizedToolCalls);
            loop.ctx().addAssistant(sandboxState.content(), tcList, sandboxState.reasoningContent());
        }
        String denyMsg = "沙箱越界已被用户拒绝。";
        loop.ctx().addAssistant(denyMsg, null, null);
        return denyMsg;
    }
}
