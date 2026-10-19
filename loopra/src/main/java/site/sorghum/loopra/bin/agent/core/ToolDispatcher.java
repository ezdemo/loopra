package site.sorghum.loopra.bin.agent.core;

import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.ONode;
import org.noear.solon.ai.chat.interceptor.ToolRequest;
import org.noear.solon.ai.chat.tool.FunctionTool;
import org.noear.solon.ai.chat.tool.ToolCall;
import site.sorghum.cutin.core.context.DefaultLoopContext;
import site.sorghum.cutin.core.loop.InterceptPoint;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.model.FileChange;
import site.sorghum.loopra.bin.agent.model.ImageToolResult;
import site.sorghum.loopra.bin.agent.model.ToolCallEntry;
import site.sorghum.loopra.bin.agent.model.ToolExecutionResult;
import site.sorghum.loopra.bin.session.SessionFileChangeTracker;
import site.sorghum.loopra.bin.session.SessionFileChangeTracker.ToolChange;
import site.sorghum.loopra.bin.tool.ToolMetadata;
import site.sorghum.loopra.integration.cutin.CutinFunctionToolBridge;
import site.sorghum.loopra.integration.cutin.plugin.toolbatch.LoopraToolBatchEvent;
import site.sorghum.loopra.integration.cutin.plugin.toolbatch.LoopraToolBatchHost;
import site.sorghum.loopra.tool.AgentOutput;
import site.sorghum.loopra.tool.HitlRequiredException;
import site.sorghum.loopra.tool.LogLevel;
import site.sorghum.loopra.tool.ToolContext;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 工具分发宿主。
 * <p>负责工具调用的解析过滤、异步并行分发、超时收集、用户中断取消、
 * 沙箱越界 HITL 汇总，以及 storm 抑制后的自纠错计数。</p>
 */
@Slf4j
final class ToolDispatcher implements LoopraToolBatchHost {

    /** 工具执行超时秒数（1080s=18min，覆盖长时间工具调用如大型构建/测试） */
    private static final int DEFAULT_TOOL_TIMEOUT_SEC = 1080;
    /** 子代理完整执行超时秒数（默认 1 小时） */
    private static final int DEFAULT_SUB_AGENT_TIMEOUT_SEC = 3600;
    /** Storm 断路器自愈最大尝试次数 */
    private static final int DEFAULT_MAX_SELF_CORRECTION = 5;
    /** 工具任务必须由可中断的 Future 承载，CompletableFuture.cancel(true) 不会中断运行线程。 */
    private static final AtomicInteger TOOL_THREAD_COUNTER = new AtomicInteger();
    private static final ExecutorService TOOL_EXECUTOR = Executors.newCachedThreadPool(r -> {
        Thread thread = new Thread(r, "loopra-tool-" + TOOL_THREAD_COUNTER.incrementAndGet());
        thread.setDaemon(true);
        return thread;
    });

    private final AgentLoop loop;

    /** 当前正在执行的工具 Future 数组（用于 abort 时取消） */
    private volatile Future<ChatMessage>[] activeToolFutures = null;

    /** 当前工具的显式取消控制器（用于停止子代理等长运行任务） */
    private volatile ToolExecutionControl[] activeToolControls = null;

    /** 工具工作线程对应的取消控制器。 */
    private final ThreadLocal<ToolExecutionControl> currentToolControl = new ThreadLocal<>();

    /** 已脱离单次工具 Future、但仍需随用户停止而终止的资源。 */
    private final ConcurrentHashMap<String, Runnable> abortResources = new ConcurrentHashMap<>();

    /** cutin 路径下的 storm 抑制标记（由 ToolPolicy 插件置位，在工具批次汇总时消费）。 */
    private final AtomicBoolean cutinSuppression = new AtomicBoolean(false);

    /**
     * 是否在工具批次结束时提取文件变更。
     * 子代理与父代理共用同一会话范围时关闭此开关，防止子循环提前取走父轮次的变更记录。
     */
    private volatile boolean drainFileChanges = true;

    ToolDispatcher(AgentLoop loop) {
        this.loop = loop;
    }

    void drainFileChanges(boolean enabled) {
        this.drainFileChanges = enabled;
    }

    void markCutinStormSuppressed() {
        cutinSuppression.set(true);
    }

    void resetCutinSuppression() {
        cutinSuppression.set(false);
    }

    @Override
    public AgentOutput getOutput() {
        return loop.getOutput();
    }

    @Override
    public String suspendSandboxHITLIfPending(DefaultLoopContext context) {
        return loop.hitlController().suspendSandboxHITLIfPending(context);
    }

    @Override
    public void applySelfCorrection(DefaultLoopContext context, ToolExecutionResult result) {
        AgentLoop.LoopState state = loop.runningCutinState();
        int updated = handleSelfCorrection(
                result.toolResults(), result.anySuppressed(),
                state == null ? 0 : state.selfCorrectionAttempts);
        if (updated < 0) {
            String fallback = "所有工具调用均被风暴断路器抑制，无法继续执行。请换用其他方式完成任务。";
            loop.ctx().addAssistant(fallback, null, null);
            context.putVariable("loopraExitReason", "self_correction");
            context.putVariable("loopraTurnResult", fallback);
            return;
        }
        if (state != null) {
            state.selfCorrectionAttempts = updated;
        }
    }

    site.sorghum.cutin.core.tool.ToolResult rejectCutinTool(
            site.sorghum.cutin.core.tool.ToolCall call,
            String message,
            String reason) {
        String result = rejectedToolResult(message, reason);
        loop.safeListener("toolResult", () -> loop.listener().onToolResult(call.toolId(), result));
        loop.safeOutputDebug("toolResult", () -> loop.getOutput().onToolResult(call.id(), call.toolId(), result, true));
        return site.sorghum.cutin.core.tool.ToolResult.failure(call.id(), result);
    }

    void registerToolCancellation(Runnable cancellation) {
        ToolExecutionControl control = currentToolControl.get();
        if (control != null) {
            control.register(cancellation);
        }
    }

    void clearToolCancellation() {
        ToolExecutionControl control = currentToolControl.get();
        if (control != null) {
            control.clearCancellation();
        }
    }

    void registerAbortResource(String resourceId, Runnable cancellation) {
        if (resourceId == null || resourceId.isBlank() || cancellation == null) return;
        if (loop.userAbortRequested()) {
            runAbortResource(resourceId, cancellation);
            return;
        }
        abortResources.put(resourceId, cancellation);
        if (loop.userAbortRequested() && abortResources.remove(resourceId, cancellation)) {
            runAbortResource(resourceId, cancellation);
        }
    }

    void clearAbortResource(String resourceId) {
        if (resourceId != null) abortResources.remove(resourceId);
    }

    void cancelActiveToolCalls() {
        cancelAllFutures(activeToolFutures, activeToolControls);
    }

    void cancelAbortResources() {
        abortResources.forEach((resourceId, cancellation) -> {
            if (abortResources.remove(resourceId, cancellation)) {
                runAbortResource(resourceId, cancellation);
            }
        });
    }

    private static void runAbortResource(String resourceId, Runnable cancellation) {
        try {
            cancellation.run();
        } catch (Exception e) {
            log.warn("[abort] 取消工具资源失败: {}, {}", resourceId, e.getMessage());
        }
    }

    private static ChatMessage toolResult(String id, String result) {
        return ChatMessage.tool(id, result);
    }

    private static ChatMessage timedToolResult(String id, String result, long startedAt) {
        return ChatMessage.tool(id, result, startedAt, System.currentTimeMillis());
    }

    private static ChatMessage timedToolResult(ChatMessage result, long startedAt) {
        result.setToolTiming(startedAt, System.currentTimeMillis());
        return result;
    }

    private int toolTimeoutSec() {
        return loop.getAgentConfig() != null ? loop.getAgentConfig().toolTimeoutSec() : DEFAULT_TOOL_TIMEOUT_SEC;
    }

    private int subAgentTimeoutSec() {
        return loop.getAgentConfig() != null ? loop.getAgentConfig().subAgentTimeoutSec() : DEFAULT_SUB_AGENT_TIMEOUT_SEC;
    }

    private int maxSelfCorrectionAttempts() {
        return loop.getAgentConfig() != null ? loop.getAgentConfig().maxSelfCorrectionAttempts() : DEFAULT_MAX_SELF_CORRECTION;
    }

    // ==================== 步骤 6: 工具执行 ====================

    ToolExecutionResult executeToolCalls(ONode toolCalls) {
        return executeToolCalls(toolCalls, null);
    }

    ToolExecutionResult executeToolCalls(ONode toolCalls, DefaultLoopContext cutinContext) {
        if (toolCalls == null){
            return new ToolExecutionResult(Collections.emptyList(), Collections.emptyList(), Collections.emptyList(), false);
        }

        List<ONode> tcArray = toolCalls.getArray();

        // 1. 解析并过滤工具调用
        ParsedToolCalls parsed = parseAndFilterToolCalls(tcArray);
        List<ONode> finalTcArray = parsed.nodeList();
        if (cutinContext != null) {
            loop.cutinEngine().intercept(
                    site.sorghum.cutin.core.loop.InterceptPoint.BEFORE_TOOL_BATCH,
                    "tool",
                    cutinContext,
                    parsed.tcList());
        }

        // 2. 异步并行分发
        DispatchResult dispatch = dispatchToolCallsAsync(finalTcArray, cutinContext);

        // 3. 等待并收集结果
        List<ChatMessage> toolResults = collectToolResults(
                dispatch.futures(), dispatch.controls(), finalTcArray, cutinContext);

        // 4. 沙箱越界 HITL
        HitlRequiredException hitlEx = dispatch.hitlRef().get();
        if (hitlEx != null) {
            loop.getHitlManager().setSandboxPending(toolCalls, hitlEx.getDetails());
            loop.safeOutput("hitl", () -> loop.getOutput().onLog(LogLevel.WARN,
                    "[hitl] 沙箱越界触发强制审批: " + hitlEx.getDetails()));
        }

        Path executionRoot = loop.getToolRegistry().getEnvironment() == null
                ? null : loop.getToolRegistry().getEnvironment().executionRoot();
        List<FileChange> fileChanges = drainFileChanges
                ? SessionFileChangeTracker.drain(executionRoot, loop.getSessionId())
                : List.of();
        boolean anySuppressed = dispatch.anySuppressed().get() || cutinSuppression.getAndSet(false);
        return new ToolExecutionResult(parsed.tcList(), toolResults, fileChanges, anySuppressed);
    }

    private record ParsedToolCalls(List<ToolCallEntry> tcList, List<ONode> nodeList) {}

    /**
     * 解析并过滤工具调用列表，同时触发 onToolCall 回调。
     *
     * @return 包含过滤后的 ToolCallEntry 列表和对应 ONode 列表的记录
     */
    private ParsedToolCalls parseAndFilterToolCalls(List<ONode> tcArray) {
        List<ToolCallEntry> tcList = new ArrayList<>();
        List<ONode> filteredTcList = new ArrayList<>();
        for (ONode tc : tcArray) {
            String tcId = tc.get("id").getString();
            ONode func = tc.get("function");
            String tcName = func.get("name").getString();
            if (tcName == null || tcName.isEmpty()) {
                loop.safeOutput("tool", () -> loop.getOutput().onLog(LogLevel.WARN,
                        "跳过无效 tool call: name=" + tcName + " id=" + tcId));
                continue;
            }
            String tcArgs = func.get("arguments").getString();
            if (tcArgs == null) tcArgs = "{}";
            String responseReasoning = tc.get("response_reasoning").getString();

            tcList.add(new ToolCallEntry(tcId, tcName, tcArgs, responseReasoning));
            filteredTcList.add(tc);

            final String finalTcName = tcName;
            final String finalTcArgs = tcArgs;
            loop.safeListener("toolCall", () -> loop.listener().onToolCall(finalTcName, finalTcArgs));
            loop.safeOutputDebug("toolCall", () -> loop.getOutput().onToolCall(tcId, finalTcName, finalTcArgs));
        }
        return new ParsedToolCalls(tcList, filteredTcList);
    }

    /**
     * 异步并行分发所有工具调用，返回 Future 数组和共享状态引用。
     */
    private static final class ToolExecutionControl {
        private final AtomicBoolean cancelled = new AtomicBoolean(false);
        private final AtomicLong startedAt = new AtomicLong(0L);
        private final AtomicReference<Runnable> cancellation = new AtomicReference<>();

        void markStarted(long timestamp) {
            startedAt.compareAndSet(0L, timestamp);
        }

        long startedAt() {
            return startedAt.get();
        }

        boolean isCancelled() {
            return cancelled.get();
        }

        void register(Runnable action) {
            if (action == null) return;
            if (cancelled.get()) {
                runCancellation(action);
                return;
            }
            cancellation.set(action);
            if (cancelled.get() && cancellation.compareAndSet(action, null)) {
                runCancellation(action);
            }
        }

        void clearCancellation() {
            cancellation.set(null);
        }

        void cancel() {
            cancelled.set(true);
            Runnable action = cancellation.getAndSet(null);
            if (action != null) {
                runCancellation(action);
            }
        }

        private static void runCancellation(Runnable action) {
            try {
                action.run();
            } catch (Exception e) {
                log.warn("[tool] 显式取消动作执行失败: {}", e.getMessage());
            }
        }
    }

    private record DispatchResult(Future<ChatMessage>[] futures,
                                  ToolExecutionControl[] controls,
                                  AtomicBoolean anySuppressed,
                                  AtomicReference<HitlRequiredException> hitlRef) {}

    private DispatchResult dispatchToolCallsAsync(List<ONode> tcArray, DefaultLoopContext cutinContext) {
        int tcCount = tcArray.size();
        @SuppressWarnings("unchecked")
        Future<ChatMessage>[] futures = new Future[tcCount];
        ToolExecutionControl[] controls = new ToolExecutionControl[tcCount];
        final AtomicBoolean anySuppressed = new AtomicBoolean(false);
        final AtomicReference<HitlRequiredException> hitlRef = new AtomicReference<>(null);
        for (int i = 0; i < tcCount; i++) {
            final int idx = i;
            controls[i] = new ToolExecutionControl();
            futures[i] = TOOL_EXECUTOR.submit(() -> {
                // 同步外部中断源（子代理检查父级 abort 状态，确保父级中断后工具不继续执行）
                Runnable extAbort = loop.externalAbortSource();
                if (extAbort != null) {
                    extAbort.run();
                }
                // 用户已中断 → 立即返回，不执行工具
                ToolExecutionControl control = controls[idx];
                if (loop.userAbortRequested() || control.isCancelled()) {
                    ONode tc = tcArray.get(idx);
                    String tcId = tc.get("id").getString();
                    return toolResult(tcId,
                            "{\"error\":\"用户已中断\",\"aborted\":true}");
                }

                currentToolControl.set(control);
                Path executionRoot = cutinContext == null
                        ? loop.workingDirectory()
                        : cutinContext.workingDirectory() != null
                            ? cutinContext.workingDirectory()
                            : loop.workingDirectory();
                SessionFileChangeTracker.bind(executionRoot, loop.getSessionId());
                SessionFileChangeTracker.beginTool();
                try {
                    ONode tc = tcArray.get(idx);
                    ToolCall toolCall = CutinStreamSupport.getToolCall(tc);
                    FunctionTool fc = loop.getToolRegistry().get(toolCall.getName());
                    // 拓展包/插件贡献的工具只注册在 cutin 视图（CutinToolRegistryView
                    // 外部注册区），存在性检查须同时覆盖两侧，避免“已注册却报工具不存在”。
                    if (fc == null && !loop.getToolRegistry().cutinRegistry().find(toolCall.getName()).isPresent()) {
                        String result = "工具不存在";
                        List<ToolChange> fileChanges = SessionFileChangeTracker.endTool();
                        loop.safeListener("toolResult", () -> loop.listener().onToolResult(toolCall.getName(), result));
                        loop.safeOutputDebug("toolResult", () -> loop.getOutput().onToolResult(toolCall.getId(), toolCall.getName(), result, true, fileChanges));
                        return toolResult(toolCall.getId(), "工具不存在");
                    }

                    // 计划模式硬约束：非只读工具直接拒绝。
                    // 正常情况下写工具已从工具列表移除，此处兼容模型凭记忆幻觉调用的兑底；
                    // 仅存在于 cutin 视图的外部工具（fc == null）不受 legacy 策略约束，由 cutin 拦截链负责。
                    if (fc != null && cutinContext == null && loop.planModeController().isPlanMode() && !ToolMetadata.isReadOnly(fc)) {
                        String result = rejectedToolResult(
                                "当前处于计划模式，仅允许只读工具；本次调用已被拒绝。请继续使用只读工具探索，完成后用 submit_plan 提交计划。",
                                "plan_mode");
                        List<ToolChange> fileChanges = SessionFileChangeTracker.endTool();
                        loop.safeListener("toolResult", () -> loop.listener().onToolResult(toolCall.getName(), result));
                        loop.safeOutputDebug("toolResult", () -> loop.getOutput().onToolResult(toolCall.getId(), toolCall.getName(), result, true, fileChanges));
                        return toolResult(toolCall.getId(), result);
                    }

                    String argumentsJson = toolCall.getArgumentsStr();
                    if (fc != null && cutinContext == null && !ToolMetadata.isStormExempt(fc)) {
                        boolean readOnly = ToolMetadata.isReadOnly(fc);
                        site.sorghum.loopra.bin.agent.resilient.StormBreaker.SuppressResult suppression =
                                loop.stormBreaker().inspect(toolCall.getName(), argumentsJson, readOnly);
                        if (suppression.suppressed()) {
                            anySuppressed.set(true);
                            String result = rejectedToolResult(suppression.reason(), "storm");
                            List<ToolChange> fileChanges = SessionFileChangeTracker.endTool();
                            loop.safeListener("toolResult", () -> loop.listener().onToolResult(toolCall.getName(), result));
                            loop.safeOutputDebug("toolResult", () -> loop.getOutput().onToolResult(toolCall.getId(), toolCall.getName(), result, true, fileChanges));
                            return toolResult(toolCall.getId(), result);
                        }
                    }

                    // 收集工具调用上下文；终端工具通过 __cwd 获取实际执行目录。
                    ToolContext.setCurrentController(loop);
                    String executionPath = executionRoot == null
                            ? null
                            : executionRoot.toAbsolutePath().normalize().toString();
                    Path environmentStateRoot = loop.getToolRegistry().getEnvironment() == null
                            ? null
                            : loop.getToolRegistry().getEnvironment().stateRoot();
                    String statePath = environmentStateRoot != null
                            ? environmentStateRoot.toAbsolutePath().normalize().toString()
                            : executionPath;
                    HashMap<String, Object> extraMap = new HashMap<>();
                    extraMap.put("__cwd", executionPath);
                    extraMap.put("ctx", new ToolContext(
                            new HashMap<>(),
                            executionPath,
                            statePath,
                            loop.getSessionId()
                    ));

                    ToolRequest req = new ToolRequest(null,extraMap, toolCall.getArguments());
                    long toolStartedAt = System.currentTimeMillis();
                    control.markStarted(toolStartedAt);
                    CutinFunctionToolBridge.setCallContext(extraMap);
                    try {
                        // 工具执行委托给 cutin 工具链；FunctionTool 通过桥接器镜像到
                        // CutinToolRegistryView，行为不变但走 cutin 的 ToolRegistry 分发。
                        site.sorghum.cutin.core.tool.ToolResult cutinResult;
                        site.sorghum.cutin.core.tool.ToolCall cutinCall =
                                new site.sorghum.cutin.core.tool.ToolCall(
                                        toolCall.getId(),
                                        toolCall.getName(),
                                        toolCall.getArguments(),
                                        toolCall.getId()
                                );
                        cutinResult = cutinContext != null
                                ? cutinContext.tools().call(cutinCall, cutinContext)
                                : loop.getToolRegistry().cutinRegistry().call(cutinCall, null);
                        String rawResult = cutinResult.ok()
                                ? String.valueOf(cutinResult.content())
                                : cutinResult.error();
                        ImageToolResult.ImageResult imageResult = ("read_image".equals(toolCall.getName())
                                || "browser_screenshot".equals(toolCall.getName()))
                                ? ImageToolResult.parseResult(rawResult) : null;
                        String result = imageResult == null ? rawResult : imageResult.summary();
                        List<ToolChange> fileChanges = SessionFileChangeTracker.endTool();
                        loop.safeListener("toolResult", () -> loop.listener().onToolResult(toolCall.getName(), result));
                        loop.safeOutputDebug("toolResult", () -> loop.getOutput().onToolResult(toolCall.getId(), toolCall.getName(), result, !cutinResult.ok(), fileChanges));
                        ChatMessage toolMessage = imageResult == null ? ChatMessage.tool(toolCall.getId(), result)
                                : ChatMessage.toolWithImage(toolCall.getId(), result,
                                imageResult.dataUri(), imageResult.detail());
                        return timedToolResult(toolMessage, toolStartedAt);
                    } catch (HitlRequiredException e) {
                        if (!loop.isHitlMode()) {
                            return timedToolResult(toolCall.getId(), "工具执行失败: " + e.getDetails(), toolStartedAt);
                        }
                        hitlRef.compareAndSet(null, e);
                        return toolResult(toolCall.getId(),
                                "[HITL_PENDING:" + e.getReason() + "] " + e.getDetails());
                    } catch (Throwable e) {
                        String result = e.getMessage();
                        List<ToolChange> fileChanges = SessionFileChangeTracker.endTool();
                        loop.safeListener("toolResult", () -> loop.listener().onToolResult(toolCall.getName(), result));
                        loop.safeOutputDebug("toolResult", () -> loop.getOutput().onToolResult(toolCall.getId(), toolCall.getName(), result, true, fileChanges));
                        return timedToolResult(toolCall.getId(), result, toolStartedAt);
                    }
                } finally {
                    CutinFunctionToolBridge.clearCallContext();
                    SessionFileChangeTracker.endTool();
                    SessionFileChangeTracker.clearBinding();
                    currentToolControl.remove();
                    ToolContext.clearCurrentController();
                }
            });
        }
        return new DispatchResult(futures, controls, anySuppressed, hitlRef);
    }

    private static String rejectedToolResult(String message, String reason) {
        return ONode.ofJson("{}")
                .asObject()
                .set("error", message)
                .set("rejectedReason", reason)
                .toJson();
    }

    /**
     * 等待所有工具 Future 完成（带超时保护），收集结果。
     * 如果用户请求中断，立即取消未完成的 Future 并返回。
     */
    private List<ChatMessage> collectToolResults(Future<ChatMessage>[] futures,
                                                 ToolExecutionControl[] controls,
                                                 List<ONode> tcArray,
                                                 DefaultLoopContext cutinContext) {
        this.activeToolControls = controls;
        this.activeToolFutures = futures;
        long startedAt = System.nanoTime();
        long regularDeadline = startedAt + TimeUnit.SECONDS.toNanos(Math.max(1, toolTimeoutSec()));
        long subAgentDeadline = startedAt + TimeUnit.SECONDS.toNanos(Math.max(1, subAgentTimeoutSec()));
        List<ChatMessage> results = new ArrayList<>(Collections.nCopies(futures.length, null));

        try {
            // 先处理普通工具，确保它们不会因同批次长运行子代理而获得更长超时。
            for (int pass = 0; pass < 2; pass++) {
                boolean waitForSubAgent = pass == 1;
                for (int i = 0; i < futures.length; i++) {
                    boolean subAgentCall = isSubAgentCall(tcArray.get(i));
                    if (subAgentCall != waitForSubAgent) continue;

                    if (loop.userAbortRequested()) {
                        cancelAllFutures(futures, controls);
                        interceptToolCancel(cutinContext, futures.length);
                        return buildAbortedResults(futures, tcArray);
                    }

                    int timeoutSec = subAgentCall ? subAgentTimeoutSec() : toolTimeoutSec();
                    long deadline = subAgentCall ? subAgentDeadline : regularDeadline;
                    long remaining = deadline - System.nanoTime();
                    String timeoutLabel = subAgentCall ? "子代理" : "工具";
                    try {
                        if (remaining <= 0) {
                            throw new TimeoutException(timeoutLabel + " execution deadline exceeded");
                        }
                        results.set(i, futures[i].get(remaining, TimeUnit.NANOSECONDS));
                    } catch (TimeoutException e) {
                        cancelFuture(futures[i], controls[i]);
                        int resultIndex = i;
                        if (cutinContext != null) {
                            loop.cutinEngine().intercept(
                                    InterceptPoint.ON_TOOL_TIMEOUT,
                                    "tool",
                                    cutinContext,
                                    new LoopraToolBatchEvent(
                                            toolName(tcArray.get(resultIndex)),
                                            timeoutSec,
                                            subAgentCall,
                                            0));
                        } else {
                            loop.safeOutput("toolTimeout", () -> loop.getOutput().onLog(LogLevel.WARN,
                                    "[tool] " + timeoutLabel + "执行超时（" + timeoutSec
                                            + "s），已请求停止: " + toolName(tcArray.get(resultIndex))));
                        }
                        results.set(i, timeoutResult(tcArray.get(i), timeoutLabel, timeoutSec, controls[i]));
                    } catch (CancellationException e) {
                        if (loop.userAbortRequested()) {
                            cancelAllFutures(futures, controls);
                            interceptToolCancel(cutinContext, futures.length);
                            return buildAbortedResults(futures, tcArray);
                        }
                        results.set(i, timeoutResult(tcArray.get(i), timeoutLabel, timeoutSec, controls[i]));
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        cancelAllFutures(futures, controls);
                        interceptToolCancel(cutinContext, futures.length);
                        return buildAbortedResults(futures, tcArray);
                    } catch (ExecutionException e) {
                        results.set(i, toolResult(tcArray.get(i).get("id").getString(),
                                "[ERROR] " + e.getMessage()));
                    }
                }
            }
        } finally {
            this.activeToolFutures = null;
            this.activeToolControls = null;
        }
        return results;
    }

    private void interceptToolCancel(DefaultLoopContext cutinContext, int count) {
        if (cutinContext != null) {
            loop.cutinEngine().intercept(
                    InterceptPoint.ON_TOOL_CANCEL,
                    "tool",
                    cutinContext,
                    new LoopraToolBatchEvent("", 0, false, count));
        }
    }

    private static boolean isSubAgentCall(ONode toolCall) {
        return "sub_agent".equals(toolName(toolCall));
    }

    private static String toolName(ONode toolCall) {
        return toolCall.get("function").get("name").getString();
    }

    private static ChatMessage timeoutResult(ONode toolCall, String label, int timeoutSec,
                                             ToolExecutionControl control) {
        String content = ONode.ofJson("{}")
                .asObject()
                .set("error", label + "执行超时（" + timeoutSec + "s）")
                .set("rejectedReason", "timeout")
                .toJson();
        long startedAt = control == null ? 0L : control.startedAt();
        return startedAt > 0L
                ? ChatMessage.tool(toolCall.get("id").getString(), content,
                startedAt, System.currentTimeMillis())
                : toolResult(toolCall.get("id").getString(), content);
    }

    private static void cancelFuture(Future<ChatMessage> future,
                                     ToolExecutionControl control) {
        if (control != null) control.cancel();
        if (future != null && !future.isDone()) future.cancel(true);
    }

    private static void cancelAllFutures(Future<ChatMessage>[] futures,
                                         ToolExecutionControl[] controls) {
        if (futures == null) return;
        for (int i = 0; i < futures.length; i++) {
            ToolExecutionControl control = controls != null && i < controls.length ? controls[i] : null;
            cancelFuture(futures[i], control);
        }
    }

    /**
     * 构建用户中断时的工具结果（全部标记为 aborted）。
     */
    private List<ChatMessage> buildAbortedResults(Future<ChatMessage>[] futures,
                                                  List<ONode> tcArray) {
        List<ChatMessage> results = new ArrayList<>();
        for (int i = 0; i < futures.length; i++) {
            ONode tc = tcArray.get(i);
            String tcId = tc.get("id").getString();
            results.add(toolResult(tcId,
                    "{\"error\":\"用户已中断\",\"aborted\":true}"));
        }
        return results;
    }

     // ==================== 自纠错 ====================

    private int handleSelfCorrection(List<ChatMessage> toolResults,
                                     boolean anySuppressed, int selfCorrectionAttempts) {
        if (!anySuppressed) return selfCorrectionAttempts;

        boolean allSuppressed = true;
        for (ChatMessage tr : toolResults) {
            String r = tr.getContent();
            if (r == null || !r.contains("\"rejectedReason\":\"storm\"")) {
                allSuppressed = false;
                break;
            }
        }
        if (!allSuppressed) return selfCorrectionAttempts;

        selfCorrectionAttempts++;
        if (selfCorrectionAttempts > maxSelfCorrectionAttempts()) {
            loop.safeOutput("selfCorrect", () -> loop.getOutput().onLog(LogLevel.WARN,
                    "[self-correct] 已达自愈尝试上限（" + maxSelfCorrectionAttempts() + "次），停止循环"));
            return -1;
        }

        final int currentAttempts = selfCorrectionAttempts;
        loop.safeOutput("selfCorrect", () -> loop.getOutput().onLog(LogLevel.INFO,
                "[self-correct] 所有工具调用被 storm 抑制，第" + currentAttempts + "次自愈尝试"));
        loop.ctx().addUser("[系统提示：你刚刚重复调用了相同的工具。请换一种方式完成任务，"
                + "或直接用文本回答。]");
        return selfCorrectionAttempts;
    }
}
