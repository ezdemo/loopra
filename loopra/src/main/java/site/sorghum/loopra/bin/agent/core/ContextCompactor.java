package site.sorghum.loopra.bin.agent.core;

import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.ONode;
import site.sorghum.cutin.core.context.DefaultLoopContext;
import site.sorghum.loopra.bin.agent.context.CompactionRangeSelector;
import site.sorghum.loopra.bin.agent.context.ContextCompactionPolicy;
import site.sorghum.loopra.bin.agent.context.ContextFolding;
import site.sorghum.loopra.bin.agent.context.ContextPressure;
import site.sorghum.loopra.bin.agent.context.ContextPressureMeter;
import site.sorghum.loopra.bin.agent.context.ContextTokenEstimate;
import site.sorghum.loopra.bin.agent.context.ContextTokenEstimator;
import site.sorghum.loopra.bin.agent.context.MessageHealer;
import site.sorghum.loopra.bin.agent.context.ToolResultPruner;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.model.PreparedMessages;
import site.sorghum.loopra.integration.cutin.CutinMessageBridge;
import site.sorghum.loopra.integration.cutin.plugin.compaction.LoopraCompactionHost;
import site.sorghum.loopra.integration.cutin.plugin.prompt.ToolContract;
import site.sorghum.loopra.integration.cutin.plugin.recovery.LoopraErrorRecoveryHost;
import site.sorghum.loopra.tool.LogLevel;

import java.io.IOException;
import java.util.Collections;
import java.util.List;
import java.util.Set;

/**
 * 上下文压力与折叠宿主。
 * <p>负责工具视图刷新（含 plan 模式只读过滤与 tool-gateway 重启）、
 * prompt 前缀冻结、按压力的自动折叠、/compact 手动折叠，
 * 以及服务端确认上下文超限后的兜底折叠恢复。</p>
 */
@Slf4j
final class ContextCompactor implements LoopraCompactionHost, LoopraErrorRecoveryHost {

    /** 服务端确认上下文超限时最多执行两次折叠恢复。 */
    private static final int MAX_CONTEXT_RECOVERIES = 2;

    private final AgentLoop loop;

    /** 冻结后的工具定义快照；freezePromptPrefix 之后保持不变。 */
    private volatile ONode frozenTools;
    /** 冻结后的工具指令快照；freezePromptPrefix 之后保持不变。 */
    private volatile String frozenToolInstructions;

    /** 上次触发 tool-gateway 重启时的禁用集合快照；用于跳过每轮无效重启。 */
    private volatile Set<String> lastGatewayDisabled = Collections.emptySet();

    /** gateway 是否已按最新禁用列表重启过；首次调用 refreshTools 时会重启一次。 */
    private volatile boolean gatewayEverStarted = false;

    ContextCompactor(AgentLoop loop) {
        this.loop = loop;
    }

    @Override
    public int maxContextRecoveries() {
        return MAX_CONTEXT_RECOVERIES;
    }

    @Override
    public boolean compactAfterContextOverflow(int recoveryAttempt) {
        return tryCompactAfterContextOverflow(recoveryAttempt);
    }

    /**
     * cutin 扩展点使用的上下文折叠入口：复用 Loopra 原有折叠策略，
     * 折叠结果回写 cutin context，由 BEFORE_MODEL 拦截器交给模型网关。
     */
    @Override
    public PreparedMessages prepareCutinMessages(DefaultLoopContext context, int step) {
        try {
            ONode tools = refreshTools();
            PreparedMessages prepared = prepareMessages(step, tools);
            context.replaceMessages(CutinMessageBridge.toCutin(prepared.messages()));
            return prepared;
        } catch (IOException exception) {
            log.warn("[cutin] BEFORE_MODEL 折叠失败，按当前上下文继续: {}", exception.getMessage());
            List<ChatMessage> fallback = loop.ctx().buildMessages();
            try {
                ONode tools = refreshTools();
                loop.lastContextEstimate(ContextTokenEstimator.estimate(fallback, tools, currentToolInstructions()));
            } catch (Exception ignored) {
                // token 估算失败时沿用上一次估值
            }
            return new PreparedMessages(fallback, false);
        }
    }

    ONode refreshTools() {
        ONode fixed = frozenTools;
        if (fixed != null) {
            return fixed;
        }
        PlanModeController planModeController = loop.planModeController();
        boolean gatewayActive = loop.cutinPlugins() != null && loop.cutinPlugins().pluginStates().stream()
                .anyMatch(s -> "loopra-tool-gateway".equals(s.id()) && s.active());
        if (!gatewayActive) {
            // 网关禁用 = 下线全部工具：清空 legacy 与 cutin 视图，模型请求的 tools 为空数组。
            // 视图区分 loopra 同步区与外部注册区（拓展包桥接、插件工具），
            // 外部注册工具不随 syncCutinRegistry 清除，需 clearTools 整体清空兜底。
            loop.getToolRegistry().clearTools();
            ONode empty = loop.getToolRegistry().toOpenAiTools();
            return planModeController.isPlanMode() ? planModeController.filterReadOnlyTools(empty) : empty;
        }
        loop.getToolRegistry().refresh();
        // 同步 cutin 工具网关：仅当禁用列表变化（或首次）时重启以按最新禁用列表重新注册 cutin Tool，
        // 避免每轮模型调用都 stop/start 网关 + 全量扫描；禁用列表不变时 registry.refresh 已同步视图。
        try {
            if (loop.cutinPlugins() != null) {
                Set<String> disabled = loop.getToolRegistry().currentDisabledTools();
                boolean disabledChanged = !disabled.equals(lastGatewayDisabled);
                if (!gatewayEverStarted || disabledChanged) {
                    loop.cutinPlugins().stopPlugin("loopra-tool-gateway");
                    loop.cutinPlugins().startPlugin("loopra-tool-gateway");
                    lastGatewayDisabled = disabled;
                    gatewayEverStarted = true;
                }
            }
        } catch (Exception e) {
            log.debug("[tool-gateway] refresh restart failed: {}", e.getMessage());
        }
        ONode tools = loop.getToolRegistry().toOpenAiTools();
        return planModeController.isPlanMode() ? planModeController.filterReadOnlyTools(tools) : tools;
    }

    /** 固定后续请求的 system 附加指令和工具定义；必须在首轮模型调用前执行。 */
    void freezePromptPrefix() {
        frozenToolInstructions = buildToolInstructions();
        ONode tools = loop.getToolRegistry().toOpenAiTools();
        PlanModeController planModeController = loop.planModeController();
        frozenTools = ONode.ofJson((planModeController.isPlanMode()
                ? planModeController.filterReadOnlyTools(tools) : tools).toJson());
    }

    String currentToolInstructions() {
        String fixed = frozenToolInstructions;
        String base = fixed != null ? fixed : buildToolInstructions();
        return loop.planModeController().isPlanMode() ? base + "\n\n" + PlanModeController.PLAN_MODE_INSTRUCTIONS : base;
    }

    private String buildToolInstructions() {
        // 静态文案与 LoopraPromptPlugin 的 tool-contract 切片共用 ToolContract 单一来源
        return ToolContract.build(loop.terminateOnNoToolCall(), loop.currentGoalInstruction());
    }

    /**
     * 从当前上下文重新计算 token 构成。
     * <p>供历史会话在未执行新一轮模型请求时按持久化消息生成预估。</p>
     */
    ContextTokenEstimate estimateCurrentContext() {
        ONode tools = refreshTools();
        ContextTokenEstimate estimate = ContextTokenEstimator.estimate(
                loop.ctx().buildMessages(), tools, currentToolInstructions());
        loop.lastContextEstimate(estimate);
        return estimate;
    }

    /** 手动触发上下文折叠（/compact 命令） */
    void compactNow() throws IOException {
        ContextCompactionPolicy policy = ContextCompactionPolicy.from(loop.getAgentConfig());
        int contextWindow = loop.getModelProvider().getMaxContextTokens();
        int retainTokens = Math.max(1, (int) Math.floor(contextWindow * policy.retainRatio()));
        if (foldOldestRange(loop.ctx().buildMessages(), retainTokens, "compact")) {
            loop.getOutput().onLog(LogLevel.INFO, "[compact] 已折叠较早历史（保留最近 ~" + retainTokens + " tokens）");
        } else {
            loop.getOutput().onLog(LogLevel.INFO, "[compact] 无需折叠（历史不足以形成可折叠范围）");
        }
    }

    /**
     * 服务端确认上下文超限时执行一次兜底折叠，避免估算误差导致请求持续失败。
     * 不依赖压力阈值，直接按有效用量的 1/4、1/8 收缩保留预算。
     */
    private boolean tryCompactAfterContextOverflow(int recoveryAttempt) {
        try {
            ContextCompactionPolicy policy = ContextCompactionPolicy.from(loop.getAgentConfig());
            ContextPressure pressure = ContextPressureMeter.measure(
                    loop.ctx().buildMessages(), null, null, loop.getLastPromptTokens(),
                    loop.getModelProvider().getMaxContextTokens(), policy);
            int retainTokens = Math.max(1,
                    pressure.effectivePromptTokens() / (4 * recoveryAttempt));
            if (!foldOldestRange(loop.ctx().buildMessages(), retainTokens, "context")) {
                loop.safeOutput("contextOverflow", () -> loop.getOutput().onLog(LogLevel.WARN,
                        "[context] 服务端确认上下文超限，但当前历史无法进一步折叠"));
                return false;
            }
            loop.safeOutput("contextOverflow", () -> loop.getOutput().onLog(LogLevel.WARN,
                    "[context] 服务端确认上下文超限，已折叠历史并重试本轮请求（保留最近 ~"
                            + retainTokens + " tokens）"));
            return true;
        } catch (IOException e) {
            log.warn("[context] 上下文超限后的兜底折叠失败: {}", e.getMessage());
            return false;
        }
    }

    /**
     * 折叠最旧的可折叠范围。选择器和摘要器共享自动、手动、溢出三条路径。
     *
     * @return true 表示历史已实际缩小并替换
     */
    private boolean foldOldestRange(List<ChatMessage> messages, int retainTokens, String logTag)
            throws IOException {
        List<ChatMessage> history = loop.ctx().getHistory();
        CompactionRangeSelector.Selection selection =
                CompactionRangeSelector.select(history, retainTokens);
        if (selection == null) {
            log.debug("[{}] 无可折叠范围（retainTokens={}）", logTag, retainTokens);
            return false;
        }
        List<ChatMessage> folded = ContextFolding.foldRange(messages, selection, loop.getModelProvider(), loop.workspace());
        if (folded.size() >= loop.ctx().size()) {
            log.warn("[{}] 折叠未缩小历史，跳过本次折叠", logTag);
            return false;
        }
        loop.ctx().compact(folded);
        loop.lastPromptTokens(0);
        loop.lastContextEstimate(null);
        return true;
    }

    // ==================== 步骤 1: 消息准备 ====================

    private PreparedMessages prepareMessages(int step, ONode tools) throws IOException {
        List<ChatMessage> messages = loop.ctx().buildMessages();
        MessageHealer.HealResult healResult = MessageHealer.heal(messages);
        messages = healResult.messages();

        String instr = currentToolInstructions();

        boolean foldedThisStep = false;
        ContextCompactionPolicy compactionPolicy = ContextCompactionPolicy.from(loop.getAgentConfig());
        ContextPressure pressure = ContextPressureMeter.measure(
                messages, tools, instr, loop.getLastPromptTokens(),
                loop.getModelProvider().getMaxContextTokens(), compactionPolicy);
        if (pressure.shouldCompact()) {
            ToolResultPruner.Config prunerConfig = ToolResultPruner.Config.from(loop.getAgentConfig());
            ToolResultPruner.PruneResult pruned = ToolResultPruner.prune(loop.ctx().getHistory(), prunerConfig);
            if (pruned.changed()) {
                loop.ctx().compact(pruned.messages());
                foldedThisStep = true;
                loop.lastPromptTokens(0);
                messages = loop.ctx().buildMessages();
                pressure = ContextPressureMeter.measure(
                        messages, tools, instr, loop.getLastPromptTokens(),
                        loop.getModelProvider().getMaxContextTokens(), compactionPolicy);
                try {
                    loop.getOutput().onLog(LogLevel.INFO, "[prune] 裁剪 " + pruned.prunedCount()
                            + " 条 tool result，释放约 " + pruned.charsRemoved() + " 字符");
                } catch (Exception e) {
                    log.warn("[prune] output.onLog异常: {}", e.getMessage());
                }
            }
        }
        int compactionAttempts = 0;
        int maxCompactionAttempts = 1 + compactionPolicy.compactionRetries();
        while (pressure.shouldCompact() && compactionAttempts < maxCompactionAttempts) {
            compactionAttempts++;
            try {
                loop.getOutput().onLog(LogLevel.INFO, "[fold] 触发折叠(" + compactionAttempts + "/"
                        + maxCompactionAttempts + "): estimatedTokens="
                        + pressure.effectivePromptTokens()
                        + " threshold=" + pressure.thresholdTokens()
                        + " maxCtx=" + pressure.contextWindow());
            } catch (Exception e) {
                log.warn("[fold] output.onLog异常: {}", e.getMessage());
            }
            if (!foldOldestRange(messages, pressure.retainTokens(), "fold")) break;
            foldedThisStep = true;
            messages = loop.ctx().buildMessages();
            pressure = ContextPressureMeter.measure(
                    messages, tools, instr, loop.getLastPromptTokens(),
                    loop.getModelProvider().getMaxContextTokens(), compactionPolicy);
        }

        try {
            loop.getOutput().onLog(LogLevel.DEBUG, "step=" + step + " messages.size=" + messages.size()
                    + " lastPromptTokens=" + loop.getLastPromptTokens() + " threshold=" + pressure.thresholdTokens());
        } catch (Exception e) {
            log.warn("[prepare] output.onLog异常: {}", e.getMessage());
        }

        // 工具协作约定已由 LoopraPromptPlugin 的 tool-contract(600) 切片注入，此处不再重复拼接；
        // 保留 instr 仅用于 token 估算的压缩阈值判断（与原语义一致）
        loop.lastContextEstimate(ContextTokenEstimator.estimate(messages, tools, null));

        return new PreparedMessages(messages, foldedThisStep);
    }
}
