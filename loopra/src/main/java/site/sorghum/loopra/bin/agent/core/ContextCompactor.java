package site.sorghum.loopra.bin.agent.core;

import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.ONode;
import site.sorghum.cutin.core.context.DefaultLoopContext;
import site.sorghum.cutin.core.context.LoopContext;
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
import site.sorghum.loopra.bin.agent.prompt.StateNoticeRenderer;
import site.sorghum.loopra.integration.cutin.CutinMessageBridge;
import site.sorghum.loopra.integration.cutin.plugin.compaction.LoopraCompactionHost;
import site.sorghum.loopra.integration.cutin.plugin.prompt.ToolContract;
import site.sorghum.loopra.integration.cutin.plugin.recovery.LoopraErrorRecoveryHost;
import site.sorghum.loopra.tool.LogLevel;

import java.io.IOException;
import java.util.ArrayList;
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

    /**
     * 冻结后的 system 文本快照（切片聚合结果）。
     * <p>
     * 冻结时装配并固定：system 是前缀缓存的主体，其 token 数在一次会话内
     * 不应随状态切换漂移，否则折叠阈值会跟着抖动。
     * </p>
     */
    private volatile String frozenSystemText;

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
            PreparedMessages prepared = prepareMessages(context, step, tools);
            context.replaceMessages(CutinMessageBridge.toCutin(prepared.messages()));
            return prepared;
        } catch (IOException exception) {
            log.warn("[cutin] BEFORE_MODEL 折叠失败，按当前上下文继续: {}", exception.getMessage());
            List<ChatMessage> fallback = loop.ctx().buildMessages();
            try {
                ONode tools = refreshTools();
                loop.lastContextEstimate(ContextTokenEstimator.estimate(fallback, tools, currentSystemText(context)));
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

    /**
     * 冻结本会话的 system 文本与工具定义；必须在首轮模型调用前执行，此后不再重冻。
     * <p>
     * <b>为什么必须冻结：</b>system 是前缀缓存的主体（上万 token），只要它在会话中途
     * 变过一个字节，其后所有请求的缓存前缀全部作废。切片本身只依赖宿主身份与工作目录
     * （见 {@code LoopraPromptPlugin.registerBuiltIns}），因此把装配结果固定一次，
     * 整个会话的 system 就是逐字节稳定的——Goal 状态、计划模式开关等易变信息已改由
     * 历史中的状态通知（{@code LoopraStateNoticePlugin}）承载，不参与此处装配。
     * </p>
     * <p>
     * <b>冻结后谁来兜底状态：</b>折叠阈值与 token 估算读同一份 {@code frozenSystemText}
     * （见 {@link #currentSystemText}），口径与真实请求一致、且不随状态切换抖动；
     * 模型侧的状态感知靠通知，约束兜底靠 {@code plan-contract} 切片与
     * {@code PlanModeController} 的执行期拒绝。
     * </p>
     * <p>
     * <b>注意 {@code frozenTools} 的语义：</b>它是会话起始时刻的工具视图快照
     * （彼时若已在计划模式，则只读过滤已生效）。中途切换计划模式不会重冻，
     * 非只读调用由 {@code ToolDispatcher} 在执行期拒绝。
     * </p>
     */
    void freezePromptPrefix() {
        frozenSystemText = assembleSystemText();
        ONode tools = loop.getToolRegistry().toOpenAiTools();
        PlanModeController planModeController = loop.planModeController();
        frozenTools = ONode.ofJson((planModeController.isPlanMode()
                ? planModeController.filterReadOnlyTools(tools) : tools).toJson());
    }

    /**
     * 折叠决策与估算使用的 system 文本 —— 即 {@code LoopraPromptPlugin} 实际注入的那份。
     * <p>
     * 冻结后直接返回快照；未冻结时（冻结前的首轮估算）与 prompt 插件共用
     * {@link site.sorghum.loopra.integration.cutin.plugin.prompt.PromptRegistry#assembleOnce}
     * 的同一次装配结果，既不重复读盘，口径也与真实请求逐字节一致。
     * </p>
     */
    private String currentSystemText(LoopContext context) {
        String frozen = frozenSystemText;
        if (frozen != null) {
            return frozen;
        }
        try {
            String text = context != null
                    ? loop.promptRegistry().assembleOnce(context)
                    : assembleSystemText();
            return text == null ? "" : text;
        } catch (Exception e) {
            log.debug("[estimate] system 装配失败，按空处理: {}", e.getMessage());
            return "";
        }
    }

    /** 无 LoopContext 时按预览上下文装配 system 文本（与前端「查看系统提示词」同一路径）。 */
    private String assembleSystemText() {
        try {
            String text = loop.effectiveSystemPrompt();
            return text == null ? "" : text;
        } catch (Exception e) {
            log.debug("[estimate] system 装配失败，按空处理: {}", e.getMessage());
            return "";
        }
    }

    /**
     * 从当前上下文重新计算 token 构成。
     * <p>供历史会话在未执行新一轮模型请求时按持久化消息生成预估。</p>
     */
    ContextTokenEstimate estimateCurrentContext() {
        ONode tools = refreshTools();
        ContextTokenEstimate estimate = ContextTokenEstimator.estimate(
                loop.ctx().buildMessages(), tools, currentSystemText(null));
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
        pruneStaleStateNotices();
        loop.lastPromptTokens(0);
        loop.lastContextEstimate(null);
        return true;
    }

    /**
     * 折叠后只保留最新一条状态通知。
     * <p>
     * 折叠已经重写全部历史、前缀缓存必然失效，此刻顺带清理陈旧通知的边际成本为零；
     * 放任堆积则每轮模型调用都要把历史里的旧 Goal 全文重复读一遍。判定用
     * {@code isUser() && isWebHidden() && isNotice()} 三元组，与
     * {@code ConversationContext.addSystemNotice} 的产物严格对应，
     * 因此不会误伤折叠摘要（摘要也是 user 消息，但不带 webHidden）。
     * </p>
     *
     * @return 被裁掉的陈旧通知条数（包级可见，便于单测直接驱动）
     */
    int pruneStaleStateNotices() {
        List<ChatMessage> history = loop.ctx().getHistory();
        int lastNotice = -1;
        for (int i = history.size() - 1; i >= 0; i--) {
            if (isStateNotice(history.get(i))) {
                lastNotice = i;
                break;
            }
        }
        if (lastNotice < 0) {
            return 0;
        }
        List<ChatMessage> retained = new ArrayList<>(history.size());
        for (int i = 0; i < history.size(); i++) {
            if (i != lastNotice && isStateNotice(history.get(i))) {
                continue;
            }
            retained.add(history.get(i));
        }
        int removed = history.size() - retained.size();
        if (removed > 0) {
            loop.ctx().compact(retained);
        }
        return removed;
    }

    private static boolean isStateNotice(ChatMessage message) {
        return message != null
                && message.isUser()
                && message.isWebHidden()
                && StateNoticeRenderer.isNotice(message.getContent());
    }

    // ==================== 步骤 1: 消息准备 ====================

    private PreparedMessages prepareMessages(LoopContext context, int step, ONode tools) throws IOException {
        List<ChatMessage> messages = loop.ctx().buildMessages();
        MessageHealer.HealResult healResult = MessageHealer.heal(messages);
        messages = healResult.messages();

        // 真实的 system 文本（切片聚合结果）：折叠阈值必须把它算进去，
        // 否则上万 token 的系统提示词完全落在估算之外，折叠会系统性触发过晚。
        String systemText = currentSystemText(context);

        boolean foldedThisStep = false;
        ContextCompactionPolicy compactionPolicy = ContextCompactionPolicy.from(loop.getAgentConfig());
        ContextPressure pressure = ContextPressureMeter.measure(
                messages, tools, systemText, loop.getLastPromptTokens(),
                loop.getModelProvider().getMaxContextTokens(), compactionPolicy);
        if (pressure.shouldCompact()) {
            ToolResultPruner.Config prunerConfig = ToolResultPruner.Config.from(loop.getAgentConfig());
            ToolResultPruner.PruneResult pruned = ToolResultPruner.prune(loop.ctx().getHistory(), prunerConfig);
            if (pruned.changed()) {
                loop.ctx().compact(pruned.messages());
                pruneStaleStateNotices();
                foldedThisStep = true;
                loop.lastPromptTokens(0);
                messages = loop.ctx().buildMessages();
                pressure = ContextPressureMeter.measure(
                        messages, tools, systemText, loop.getLastPromptTokens(),
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
                    messages, tools, systemText, loop.getLastPromptTokens(),
                    loop.getModelProvider().getMaxContextTokens(), compactionPolicy);
        }

        try {
            loop.getOutput().onLog(LogLevel.DEBUG, "step=" + step + " messages.size=" + messages.size()
                    + " lastPromptTokens=" + loop.getLastPromptTokens() + " threshold=" + pressure.thresholdTokens());
        } catch (Exception e) {
            log.warn("[prepare] output.onLog异常: {}", e.getMessage());
        }

        // 上下文构成上报与折叠阈值同源：system 计入真实切片聚合文本，
        // 前端展示的 token 分布才与实际请求一致
        loop.lastContextEstimate(ContextTokenEstimator.estimate(messages, tools, systemText));

        return new PreparedMessages(messages, foldedThisStep);
    }
}
