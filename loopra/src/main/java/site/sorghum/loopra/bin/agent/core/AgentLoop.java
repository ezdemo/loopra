package site.sorghum.loopra.bin.agent.core;

import lombok.Getter;
import lombok.Setter;
import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.Feature;
import org.noear.snack4.ONode;
import org.noear.snack4.Options;
import org.noear.snack4.json.JsonReader;
import org.noear.snack4.json.util.FormatUtil;
import org.noear.solon.ai.chat.interceptor.ToolRequest;
import org.noear.solon.ai.chat.tool.FunctionTool;
import org.noear.solon.ai.chat.tool.ToolCall;
import site.sorghum.cutin.core.context.Budget;
import site.sorghum.cutin.core.context.DefaultLoopContext;
import site.sorghum.cutin.core.context.Usage;
import site.sorghum.cutin.core.event.LoopEvent;
import site.sorghum.cutin.core.loop.*;
import site.sorghum.cutin.core.model.ModelCallRequest;
import site.sorghum.cutin.core.model.ModelRegistry;
import site.sorghum.cutin.core.model.ModelResponse;
import site.sorghum.cutin.core.model.StreamChunk;
import site.sorghum.cutin.core.plugin.PluginBeanManager;
import site.sorghum.cutin.core.state.LoopSnapshot;
import site.sorghum.loopra.bin.agent.context.*;
import site.sorghum.loopra.bin.agent.hitl.HitlManager;
import site.sorghum.loopra.bin.agent.listener.AgentLoopListener;
import site.sorghum.loopra.bin.agent.listener.NoOpAgentLoopListener;
import site.sorghum.loopra.bin.agent.model.*;
import site.sorghum.loopra.bin.agent.output.ConsoleAgentOutput;
import site.sorghum.loopra.bin.agent.resilient.ReasonBreaker;
import site.sorghum.loopra.bin.agent.resilient.Scavenger;
import site.sorghum.loopra.bin.agent.resilient.StormBreaker;
import site.sorghum.loopra.bin.agent.spi.AgentConfig;
import site.sorghum.loopra.bin.agent.spi.GoalGuard;
import site.sorghum.loopra.bin.agent.spi.SessionUsageSink;
import site.sorghum.loopra.bin.model.LoopraModelProvider;
import site.sorghum.loopra.bin.model.ModelApiError;
import site.sorghum.loopra.bin.model.UserMessageSanitizer;
import site.sorghum.loopra.bin.agent.environment.SessionEnvironment;
import site.sorghum.loopra.bin.session.SessionFileChangeTracker;
import site.sorghum.loopra.bin.tool.ToolMetadata;
import site.sorghum.loopra.bin.tool.ToolRegistry;
import site.sorghum.loopra.integration.cutin.CutinFunctionToolBridge;
import site.sorghum.loopra.integration.cutin.CutinMessageBridge;
import site.sorghum.loopra.integration.cutin.plugin.compaction.LoopraCompactionHost;
import site.sorghum.loopra.integration.cutin.plugin.compaction.LoopraCompactionPlugin;
import site.sorghum.loopra.integration.cutin.plugin.LoopraPluginRuntime;
import site.sorghum.loopra.integration.extpack.LoopraExtPackRuntime;
import site.sorghum.loopra.integration.cutin.plugin.external.ExternalPluginStore;
import site.sorghum.loopra.integration.cutin.plugin.exit.LoopraExitHost;
import site.sorghum.loopra.integration.cutin.plugin.exit.LoopraExitPlugin;
import site.sorghum.loopra.integration.cutin.plugin.httplog.LoopraHttpLogPlugin;
import site.sorghum.loopra.integration.cutin.plugin.plan.LoopraPlanHost;
import site.sorghum.loopra.integration.cutin.plugin.plan.LoopraPlanPlugin;
import site.sorghum.loopra.integration.cutin.plugin.policy.LoopraMessageHealingPlugin;
import site.sorghum.loopra.integration.cutin.plugin.policy.LoopraModelPolicyPlugin;
import site.sorghum.loopra.integration.cutin.plugin.policy.LoopraPolicyHost;
import site.sorghum.loopra.integration.cutin.plugin.policy.LoopraToolPolicyPlugin;
import site.sorghum.loopra.integration.cutin.plugin.preflight.*;
import site.sorghum.loopra.integration.cutin.plugin.rawlog.LoopraRawLogPlugin;
import site.sorghum.loopra.integration.cutin.plugin.reasoning.LoopraReasoningStartedHost;
import site.sorghum.loopra.integration.cutin.plugin.reasoning.LoopraReasoningStartedPlugin;
import site.sorghum.loopra.integration.cutin.plugin.recovery.LoopraErrorRecoveryHost;
import site.sorghum.loopra.integration.cutin.plugin.recovery.LoopraErrorRecoveryPlugin;
import site.sorghum.loopra.integration.cutin.plugin.retry.LoopraRetryHost;
import site.sorghum.loopra.integration.cutin.plugin.retry.LoopraRetryPolicyPlugin;
import site.sorghum.loopra.integration.cutin.plugin.session.LoopraSessionAffinityHost;
import site.sorghum.loopra.integration.cutin.plugin.session.LoopraSessionAffinityPlugin;
import site.sorghum.loopra.integration.cutin.plugin.session.LoopraSessionHost;
import site.sorghum.loopra.integration.cutin.plugin.session.LoopraSessionPlugin;
import site.sorghum.loopra.integration.cutin.plugin.toolbatch.LoopraToolBatchEvent;
import site.sorghum.loopra.integration.cutin.plugin.toolbatch.LoopraToolBatchHost;
import site.sorghum.loopra.integration.cutin.plugin.toolbatch.LoopraToolBatchPlugin;
import site.sorghum.loopra.integration.cutin.plugin.prompt.LoopraPromptHost;
import site.sorghum.loopra.integration.cutin.plugin.prompt.LoopraPromptPlugin;
import site.sorghum.loopra.integration.cutin.plugin.prompt.PromptRegistry;
import site.sorghum.loopra.integration.cutin.plugin.prompt.ToolContract;
import site.sorghum.loopra.integration.cutin.plugin.tool.LoopraToolGatewayPlugin;
import site.sorghum.loopra.integration.cutin.plugin.usage.LoopraTokenSpeedHost;
import site.sorghum.loopra.integration.cutin.plugin.usage.LoopraTokenSpeedPlugin;
import site.sorghum.loopra.integration.cutin.plugin.usage.LoopraUsageHost;
import site.sorghum.loopra.integration.cutin.plugin.usage.LoopraUsagePlugin;
import site.sorghum.loopra.tool.*;
import site.sorghum.loopra.tool.interact.FinishTool;

import java.io.IOException;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import java.util.stream.Stream;

/**
 * Agent 循环 —— 编排 prompt → LLM → 工具调用 → 反馈结果 → LLM 的循环。
 * <p>
 * 消息历史通过 {@link ConversationContext} 在内存中累积跨回合持久化。
 * HITL（人工审批）逻辑委托给 {@link HitlManager} 管理。
 * </p>
 *
 * @author Sorghum
 */
@Slf4j
public class AgentLoop implements
        AgentLoopController,
        LoopraPolicyHost,
        LoopraCompactionHost,
        LoopraUsageHost,
        LoopraTokenSpeedHost,
        LoopraSessionAffinityHost,
        LoopraExitHost,
        LoopraErrorRecoveryHost,
        LoopraRetryHost,
        LoopraSessionHost,
        LoopraPlanHost,
        LoopraToolBatchHost,
        LoopraReasoningStartedHost,
        LoopraPreflightHost,
        LoopraPromptHost,
        LoopraToolGatewayPlugin.LoopraToolHost {

    // ==================== 配置读取（带 null-safe 默认值） ====================

    /** 默认最大上下文字符数（200k 约 256k tokens 的保守估计，覆盖主流模型上下文窗口） */
    private static final int DEFAULT_MAX_CONTEXT_CHARS = 200_000;
    /** 折叠后保留尾部字符数（80k 确保折叠后仍有足够上下文供后续推理） */
    private static final int DEFAULT_KEEP_TAIL_CHARS = 80_000;
    /** 工具执行超时秒数（1080s=18min，覆盖长时间工具调用如大型构建/测试） */
    private static final int DEFAULT_TOOL_TIMEOUT_SEC = 1080;
    /** 子代理完整执行超时秒数（默认 1 小时） */
    private static final int DEFAULT_SUB_AGENT_TIMEOUT_SEC = 3600;
    /** Storm 断路器自愈最大尝试次数 */
    private static final int DEFAULT_MAX_SELF_CORRECTION = 5;
    /** 流式响应等待超时秒数（防止 HTTP 流永不结束导致线程挂起） */
    private static final int DEFAULT_STREAM_LATCH_TIMEOUT_SEC = 300;
    /** 服务端确认上下文超限时最多执行两次折叠恢复。 */
    private static final int MAX_CONTEXT_RECOVERIES = 2;
    /** 工具任务必须由可中断的 Future 承载，CompletableFuture.cancel(true) 不会中断运行线程。 */
    private static final AtomicInteger TOOL_THREAD_COUNTER = new AtomicInteger();
    private static final ExecutorService TOOL_EXECUTOR = Executors.newCachedThreadPool(r -> {
        Thread thread = new Thread(r, "loopra-tool-" + TOOL_THREAD_COUNTER.incrementAndGet());
        thread.setDaemon(true);
        return thread;
    });

    private int maxTotalChars() {
        return config != null ? config.maxContextChars() : DEFAULT_MAX_CONTEXT_CHARS;
    }

    private int keepTailChars() {
        return config != null ? config.keepTailChars() : DEFAULT_KEEP_TAIL_CHARS;
    }

    private int toolTimeoutSec() {
        return config != null ? config.toolTimeoutSec() : DEFAULT_TOOL_TIMEOUT_SEC;
    }

    private int subAgentTimeoutSec() {
        return config != null ? config.subAgentTimeoutSec() : DEFAULT_SUB_AGENT_TIMEOUT_SEC;
    }

    private int maxSelfCorrectionAttempts() {
        return config != null ? config.maxSelfCorrectionAttempts() : DEFAULT_MAX_SELF_CORRECTION;
    }

    // ==================== 核心字段 ====================

    private final LoopraModelProvider modelProvider;
    private final ToolRegistry registry;
    private final AgentConfig config;
    private volatile boolean terminateOnNoToolCall;
    @Getter
    private final ConversationContext ctx;
    private final ReasonBreaker reasonBreaker = new ReasonBreaker();
    private final StormBreaker stormBreaker;
    private final AtomicBoolean cutinSuppression = new AtomicBoolean(false);
    private ToolCallValidator toolCallValidator;
    /** Goal 守卫（由上层注入）；null 时等价于无开放 Goal，守卫全部放行。 */
    @Setter
    private volatile GoalGuard goalGuard;
    /** Goal 生命周期只由拥有会话的主代理约束，子代理共享 sessionId 但不拥有 Goal。 */
    @Setter
    private volatile boolean goalGuardEnabled = true;
    /** 子代理可冻结这两部分，确保其整个生命周期内模型请求前缀完全一致。 */
    private volatile ONode frozenTools;
    private volatile String frozenToolInstructions;
    /**
     * 计划模式 —— 会话级状态：仅允许只读工具（工具列表过滤 + 执行拒绝 + 指令感知）。
     * 由 /plan、/execute 命令切换；不修改共享的 ToolRegistry，因此不影响同项目的其他会话。
     */
    private volatile boolean planMode = false;
    /**
     * 计划模式下经 submit_plan 提交、待用户审查的执行计划。
     * /execute 批准时取出并注入为执行依据（取出即清空）。
     */
    private volatile String pendingPlan = null;
    @Getter
    private final HitlManager hitlManager;

    @Setter
    private SessionUsageSink sessionUsageSink;

    private AgentLoopListener listener = NoOpAgentLoopListener.INSTANCE;

    @Getter
    private AgentOutput output = new ConsoleAgentOutput();

    /** 最近一次 API 返回的 prompt_tokens（0 = 尚无数据，回退到字符估算） */
    @Getter
    private int lastPromptTokens = 0;

    /** 最近一次请求的离线上下文构成，用于展示和折叠预检。 */
    @Getter
    private volatile ContextTokenEstimate lastContextEstimate;

    /** 用户主动中断标志（前端点击停止按钮时设置） */
    private volatile boolean userAbortRequested = false;

    /** 外部中断源（Runnable）—— 由父级 AgentLoopController 设置，子代理主循环会同步检查 */
    private volatile Runnable externalAbortSource = null;

    /** 外部中断条件（父代理中断或子代理显式取消）。 */
    private volatile BooleanSupplier externalAbortCheck = null;

    /** 项目根目录 —— compact 折叠时用于沉淀长期记忆到 .loopra/loopra-memory.md。 null 则跳过沉淀。 */
    @Setter
    @Getter
    private volatile Path workspace;

    /** 当前正在执行的工具 Future 数组（用于 abort 时取消） */
    private volatile Future<ChatMessage>[] activeToolFutures = null;

    /** 当前工具的显式取消控制器（用于停止子代理等长运行任务） */
    private volatile ToolExecutionControl[] activeToolControls = null;

    /** 工具工作线程对应的取消控制器。 */
    private final ThreadLocal<ToolExecutionControl> currentToolControl = new ThreadLocal<>();

    /** 已脱离单次工具 Future、但仍需随用户停止而终止的资源。 */
    private final ConcurrentHashMap<String, Runnable> abortResources = new ConcurrentHashMap<>();

    /** 任务完成标志 —— finish 工具设置，非空时主循环将退出并返回该内容 */
    private volatile String finishContent = null;

    @Getter
    private volatile String sessionId;

    /** 设置当前会话 ID，并同步给模型 Provider 以支持会话级路由。 */
    public void setSessionId(String sessionId) {
        this.sessionId = sessionId;
        modelProvider.setSessionAffinity(sessionId);
    }

    /** 上次触发 tool-gateway 重启时的禁用集合快照；用于跳过每轮无效重启。 */
    private volatile Set<String> lastGatewayDisabled = Collections.emptySet();

    /** gateway 是否已按最新禁用列表重启过；首次调用 refreshTools 时会重启一次。 */
    private volatile boolean gatewayEverStarted = false;

    /** Prompt 插件化：切片注册表（供外部插件热插拔） */
    @Getter
    private final PromptRegistry promptRegistry = new PromptRegistry();

    /**
     * 是否在工具批次结束时提取文件变更。
     * 子代理与父代理共用同一会话范围时关闭此开关，防止子循环提前取走父轮次的变更记录。
     */
    @Setter
    private volatile boolean drainFileChanges = true;

    /** 主循环是否正在执行中（防止巡检线程与主循环冲突） */
    private final AtomicBoolean running = new AtomicBoolean(false);

    /**
     * cutin 引擎 —— loopra 主循环的编排状态机。
     * HITL、计划模式、上下文折叠、ReasonBreaker、StormBreaker 由
     * {@link LoopraModelPolicyPlugin} / {@link LoopraToolPolicyPlugin} 以 cutin
     * 拦截点实现，循环推进、检查点、
     * 事件和预算由 cutin 管理。
     */
    private final DefaultLoopEngine cutinEngine;
    private final PluginBeanManager cutinPlugins;
    private volatile LoopHandle activeCutinHandle;
    private volatile LoopHandle suspendedCutinHandle;
    private volatile DefaultLoopContext suspendedCutinContext;
    private volatile LoopState suspendedCutinState;
    private volatile LoopState runningCutinState;

    /**
     * 查询主循环是否正在执行。
     *
     * @return true 表示当前 Agent 正在处理一个回合
     */
    public boolean isRunning() {
        return running.get();
    }

    private Path workingDirectory() {
        Path environmentRoot = registry.getEnvironment() == null
            ? null
            : registry.getEnvironment().executionRoot();
        Path root = environmentRoot != null ? environmentRoot : workspace;
        return root == null ? null : root.toAbsolutePath().normalize();
    }

    // ==================== 构造器 ====================

    public AgentLoop(LoopraModelProvider modelProvider, ToolRegistry registry, ConversationContext ctx,
                     AgentConfig config) {
        this.modelProvider = Objects.requireNonNull(modelProvider, "modelProvider must not be null");
        this.registry = Objects.requireNonNull(registry, "registry must not be null");
        this.ctx = ctx;
        this.config = config;
        this.terminateOnNoToolCall = config == null || config.terminateOnNoToolCall();
        this.hitlManager = new HitlManager("free");
        this.hitlManager.setConfig(config);
        this.stormBreaker = StormBreaker.fromConfig(config);
        Path executionRoot = registry.getEnvironment() == null
                ? null
                : registry.getEnvironment().executionRoot();
        this.toolCallValidator = ToolCallValidator.fromConfig(config, executionRoot);
        this.cutinEngine = new DefaultLoopEngine(registry.cutinRegistry(), new ModelRegistry());
        this.cutinEngine.registrar().addModelProvider(modelProvider);
        this.cutinPlugins = createCutinPlugins();
    }

    // ========== LoopraPromptHost / LoopraToolHost / LoopraPolicyHost 实现 ==========
    @Override
    public SessionEnvironment environment() {
        return registry.getEnvironment();
    }

    @Override
    public ToolRegistry toolRegistry() {
        return registry;
    }

    @Override
    public site.sorghum.cutin.core.tool.ToolRegistry getCutinTools() {
        if (cutinEngine == null) return null;
        if (cutinEngine.registrar() instanceof site.sorghum.cutin.core.plugin.DefaultLoopRegistrar d) return d.tools();
        return null;
    }

    @Override
    public PromptRegistry promptRegistry() {
        return promptRegistry;
    }

    @Override
    public Path workspace() {
        SessionEnvironment env = registry.getEnvironment();
        return env == null ? null : env.executionRoot();
    }

    @Override
    public String dynamicToolContractTail() {
        // Goal 指令 + Plan Mode 指令：随会话状态实时变化，由 tool-contract 切片注入 system
        StringBuilder tail = new StringBuilder();
        String goal = currentGoalInstruction();
        if (!goal.isBlank()) {
            tail.append(goal);
        }
        if (planMode) {
            if (!tail.isEmpty()) {
                tail.append("\n\n");
            }
            tail.append(PLAN_MODE_INSTRUCTIONS);
        }
        return tail.toString();
    }

    private PluginBeanManager createCutinPlugins() {
        PluginBeanManager plugins = new PluginBeanManager(cutinEngine.registrar());
        // 暴露宿主与 PromptRegistry 供插件热插拔
        plugins.registerBean("loopraPromptHost", (LoopraPromptHost) this);
        plugins.registerBean("promptRegistry", promptRegistry);
        plugins.registerBean("loopraToolHost", (LoopraToolGatewayPlugin.LoopraToolHost) this);
        plugins.registerBean("promptRegistryTyped", promptRegistry);
        // Prompt / Tool 插件化（优先级最高，最先拦截）
        plugins.registerPlugin(new LoopraPromptPlugin(this, promptRegistry));
        plugins.registerPlugin(new LoopraToolGatewayPlugin(this));
        plugins.registerPlugin(new LoopraHttpLogPlugin(modelProvider));
        plugins.registerPlugin(new LoopraRawLogPlugin());
        plugins.registerPlugin(new LoopraMessageSanitizerPlugin(this));
        plugins.registerPlugin(new LoopraHitlPlugin(this));
        plugins.registerPlugin(new LoopraUserMessagePlugin(this));
        plugins.registerPlugin(new LoopraUsagePlugin(this));
        plugins.registerPlugin(new LoopraTokenSpeedPlugin(this));
        plugins.registerPlugin(new LoopraSessionAffinityPlugin(this));
        plugins.registerPlugin(new LoopraCompactionPlugin(this));
        plugins.registerPlugin(new LoopraReasoningStartedPlugin(this));
        plugins.registerPlugin(new LoopraModelPolicyPlugin(this));
        plugins.registerPlugin(new LoopraMessageHealingPlugin());
        plugins.registerPlugin(new LoopraToolPolicyPlugin(this));
        plugins.registerPlugin(new LoopraExitPlugin(this));
        plugins.registerPlugin(new LoopraErrorRecoveryPlugin(this));
        plugins.registerPlugin(new LoopraRetryPolicyPlugin(this));
        plugins.registerPlugin(new LoopraSessionPlugin(this));
        plugins.registerPlugin(new LoopraPlanPlugin(this));
        plugins.registerPlugin(new LoopraToolBatchPlugin(this));
        // 外置插件：startAll 前按清单加载，与内置插件同场竞技
        new ExternalPluginStore().loadInto(plugins);
        plugins.startAll();
        LoopraPluginRuntime.attach(plugins, config == null ? Set.of() : config.disabledPlugins());
        // 拓展包桥接：登记本 AgentLoop 的注册中心，已启动拓展包自动补注册
        LoopraExtPackRuntime.attach(cutinEngine.registrar());
        return plugins;
    }

    /** 仅测试注入：覆盖由配置生成的工具调用校验器，避免为测试保留专用构造器。 */
    void setToolCallValidator(ToolCallValidator toolCallValidator) {
        this.toolCallValidator = Objects.requireNonNull(toolCallValidator, "toolCallValidator must not be null");
    }

    void disposeCutinPlugins() {
        LoopraPluginRuntime.detach(cutinPlugins);
        LoopraExtPackRuntime.detach(cutinEngine.registrar());
        cutinPlugins.stopAll();
    }

    // ==================== 公共控制 API ====================

    /** 切换 HITL 模式 */
    public void toggleHitl() {
        hitlManager.toggleHitl();
    }

    /** 获取 HITL 模式状态 */
    @Override
    public boolean isHitlMode() {
        return hitlManager.isHitlMode();
    }

    /**
     * 获取当前 HITL 模式名称。
     */
    @Override
    public String getHitlMode() {
        return hitlManager.getHitlMode();
    }

    /** 设置 HITL 模式（用于配置热更新） */
    public void setHitlMode(String mode) {
        hitlManager.setHitlMode(mode);
    }

    /** 批准待执行的工具调用 */
    public void approveHITL() {
        hitlManager.approveHITL();
    }

    /** 拒绝待执行的工具调用 */
    public void denyHITL() {
        hitlManager.denyHITL();
    }

    /** 是否有待审批的工具调用 */
    public boolean hasPendingHITL() {
        return hitlManager.hasPendingHITL();
    }

    /** 获取模型最大上下文窗口 token 数 */
    public int getMaxContextTokens() {
        return modelProvider.getMaxContextTokens();
    }

    /** 获取当前会话使用的模型。 */
    public String getModel() {
        return modelProvider.getModel();
    }

    /** 获取当前会话使用的模型渠道。 */
    public String getModelChannelId() {
        return modelProvider.getModelChannelId();
    }

    /** 获取当前会话使用的思考强度。 */
    public String getReasoningEffort() {
        return modelProvider.getReasoningEffort();
    }

    /** 运行时切换模型（热更新） */
    public void setModel(String model) {
        modelProvider.setModel(model);
    }

    /** 运行时切换推理强度（热更新） */
    public void setReasoningEffort(String reasoningEffort) {
        modelProvider.setReasoningEffort(reasoningEffort);
    }

    /** 运行时切换最大输出 token 数（热更新，包含推理 token）。 */
    public void setMaxTokens(int maxTokens) {
        modelProvider.setMaxTokens(maxTokens);
    }

    /** 运行时切换快速模式（热更新，OpenAI service_tier=fast，仅 OpenAI 协议生效） */
    public void setFastMode(boolean fastMode) {
        modelProvider.setFastMode(fastMode);
    }

    @Override
    public boolean terminateOnNoToolCall() {
        return terminateOnNoToolCall;
    }

    /** 运行时更新无工具调用时的结束策略。 */
    public void setTerminateOnNoToolCall(boolean enabled) {
        this.terminateOnNoToolCall = enabled;
    }

    /** 手动触发上下文折叠（/compact 命令） */
    public void compactNow() throws IOException {
        ContextCompactionPolicy policy = ContextCompactionPolicy.from(config);
        int contextWindow = modelProvider.getMaxContextTokens();
        int retainTokens = Math.max(1, (int) Math.floor(contextWindow * policy.retainRatio()));
        if (foldOldestRange(ctx.buildMessages(), retainTokens, "compact")) {
            output.onLog(LogLevel.INFO, "[compact] 已折叠较早历史（保留最近 ~" + retainTokens + " tokens）");
        } else {
            output.onLog(LogLevel.INFO, "[compact] 无需折叠（历史不足以形成可折叠范围）");
        }
    }

    /**
     * 用户主动中断：设置中断标志、中止当前 HTTP 流式请求、取消正在执行的工具。
     */
    public void requestUserAbort() {
        doAbort();
    }

    /**
     * 检查用户是否已请求中断（供 AgentLoopController 接口实现）。
     * <p>子代理中此方法还会同步检查父级的中断状态，确保在长工具执行期间也能及时响应父级中止。</p>
     */
    @Override
    public boolean isAbortRequested() {
        Runnable source = externalAbortSource;
        if (source != null) source.run();
        return userAbortRequested;
    }

    /** 重置用户中断标志（每回合开始时调用） */
    public void resetUserAbort() {
        userAbortRequested = false;
        modelProvider.resetStreamAbort();
    }

    public void setListener(AgentLoopListener listener) {
        this.listener = listener != null ? listener : NoOpAgentLoopListener.INSTANCE;
    }

    public void setOutput(AgentOutput output) {
        this.output = output != null ? output : AgentOutput.NOOP;
    }

    /**
     * 设置外部中断源 —— 子代理通过此方法绑定父级的 AgentLoopController。
     * <p>
     * 子代理的主循环和流式调用中会同步检查父级的 isAbortRequested()，
     * 一旦父级请求中断，子代理会立即设置自身的 userAbortRequested 并中止 HTTP 流。
     * </p>
     *
     * @param parentController 父级的 AgentLoopController（可 null 表示无父级）
     */
    public void setExternalAbortSource(AgentLoopController parentController) {
        if (parentController == null) {
            this.externalAbortSource = null;
            this.externalAbortCheck = null;
            return;
        }
        setExternalAbortCheck(parentController::isAbortRequested);
    }

    void setExternalAbortCheck(BooleanSupplier abortCheck) {
        this.externalAbortCheck = abortCheck;
        this.externalAbortSource = () -> {
            BooleanSupplier check = this.externalAbortCheck;
            if (check != null && check.getAsBoolean() && !userAbortRequested) {
                doAbort();
                log.info("[loop] 检测到外部中断信号，子代理同步中止");
            }
        };
    }

    // ==================== AgentLoopController 实现 ====================

    @Override
    public void requestStop() {
        doAbort();
        log.info("[loop] 工具请求停止推理循环");
    }

    /**
     * 统一的中断实现：设置标志、中止流式请求、取消工具 Future。
     */
    private void doAbort() {
        userAbortRequested = true;
        modelProvider.abortStream();
        LoopHandle handle = activeCutinHandle;
        if (handle != null) {
            handle.cancel(CancelReason.USER);
        }
        cancelAllFutures(activeToolFutures, activeToolControls);
        cancelAbortResources();
    }

    @Override
    public void finish(String content) {
        if (content == null || content.isBlank()) {
            // 尝试从上下文获取最后一条 assistant 回复作为回退
            String lastAssistant = ctx.getLastAssistantContent();
            if (lastAssistant != null && !lastAssistant.isBlank()) {
                content = lastAssistant;
                log.info("[loop] finish content 为空，使用最后一条 assistant 回复作为回退");
            } else {
                content = "(completed)";
                log.info("[loop] finish content 为空且无 assistant 回复可回退，使用默认值");
            }
        }
        this.finishContent = content;
        modelProvider.abortStream();
        log.info("[loop] 工具请求完成任务，即将退出循环");
    }

    @Override
    public void injectUserMessage(String message) {
        if (message == null || message.isEmpty()) return;
        ctx.addUser("[系统注入] " + message);
        log.info("[loop] 工具注入用户消息: {}...",
                message.length() > 80 ? message.substring(0, 80) + "..." : message);
    }

    @Override
    public ToolRegistry getToolRegistry() {
        return registry;
    }

    @Override
    public SessionUsageSink getSessionUsageSink() {
        return this.sessionUsageSink;
    }

    @Override
    public LoopraModelProvider getModelProvider() {
        return modelProvider;
    }

    @Override
    public AgentConfig getAgentConfig() {
        return config;
    }

    @Override
    public void registerToolCancellation(Runnable cancellation) {
        ToolExecutionControl control = currentToolControl.get();
        if (control != null) {
            control.register(cancellation);
        }
    }

    @Override
    public void clearToolCancellation() {
        ToolExecutionControl control = currentToolControl.get();
        if (control != null) {
            control.clearCancellation();
        }
    }

    @Override
    public void registerAbortResource(String resourceId, Runnable cancellation) {
        if (resourceId == null || resourceId.isBlank() || cancellation == null) return;
        if (userAbortRequested) {
            runAbortResource(resourceId, cancellation);
            return;
        }
        abortResources.put(resourceId, cancellation);
        if (userAbortRequested && abortResources.remove(resourceId, cancellation)) {
            runAbortResource(resourceId, cancellation);
        }
    }

    @Override
    public void clearAbortResource(String resourceId) {
        if (resourceId != null) abortResources.remove(resourceId);
    }

    private void cancelAbortResources() {
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

    // ==================== 内部辅助方法 ====================

    /** 安全调用 output 方法，异常记录 warn 日志（用于 onLog/onError/onToolCall/onToolResult 等） */
    private void safeOutput(String tag, Runnable action) {
        try {
            action.run();
        } catch (Exception e) {
            log.warn("[{}] output异常: {}", tag, e.getMessage());
        }
    }

    /** 安全调用 output 方法，异常记录 debug 日志（用于 SSE delta 回调，断开是预期行为） */
    private void safeOutputDebug(String tag, Runnable action) {
        try {
            action.run();
        } catch (Exception e) {
            log.debug("[{}] output异常(SSE可能已断开): {}", tag, e.getMessage());
        }
    }

    /** 安全调用 listener 方法，异常记录 warn 日志 */
    private void safeListener(String tag, Runnable action) {
        try {
            action.run();
        } catch (Exception e) {
            log.warn("[{}] listener异常: {}", tag, e.getMessage());
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

    public ONode refreshTools() {
        ONode fixed = frozenTools;
        if (fixed != null) {
            return fixed;
        }
        boolean gatewayActive = cutinPlugins != null && cutinPlugins.pluginStates().stream()
                .anyMatch(s -> "loopra-tool-gateway".equals(s.id()) && s.active());
        if (!gatewayActive) {
            // 网关禁用 = 下线全部工具：清空 legacy 与 cutin 视图，模型请求的 tools 为空数组。
            // 视图区分 loopra 同步区与外部注册区（拓展包桥接、插件工具），
            // 外部注册工具不随 syncCutinRegistry 清除，需 clearTools 整体清空兜底。
            registry.clearTools();
            ONode empty = registry.toOpenAiTools();
            return planMode ? filterReadOnlyTools(empty) : empty;
        }
        registry.refresh();
        // 同步 cutin 工具网关：仅当禁用列表变化（或首次）时重启以按最新禁用列表重新注册 cutin Tool，
        // 避免每轮模型调用都 stop/start 网关 + 全量扫描；禁用列表不变时 registry.refresh 已同步视图。
        try {
            if (cutinPlugins != null) {
                Set<String> disabled = registry.currentDisabledTools();
                boolean disabledChanged = !disabled.equals(lastGatewayDisabled);
                if (!gatewayEverStarted || disabledChanged) {
                    cutinPlugins.stopPlugin("loopra-tool-gateway");
                    cutinPlugins.startPlugin("loopra-tool-gateway");
                    lastGatewayDisabled = disabled;
                    gatewayEverStarted = true;
                }
            }
        } catch (Exception e) {
            log.debug("[tool-gateway] refresh restart failed: {}", e.getMessage());
        }
        ONode tools = registry.toOpenAiTools();
        return planMode ? filterReadOnlyTools(tools) : tools;
    }

    /** 固定后续请求的 system 附加指令和工具定义；必须在首轮模型调用前执行。 */
    public void freezePromptPrefix() {
        frozenToolInstructions = buildToolInstructions();
        ONode tools = registry.toOpenAiTools();
        frozenTools = ONode.ofJson((planMode ? filterReadOnlyTools(tools) : tools).toJson());
    }

    private String currentToolInstructions() {
        String fixed = frozenToolInstructions;
        String base = fixed != null ? fixed : buildToolInstructions();
        return planMode ? base + "\n\n" + PLAN_MODE_INSTRUCTIONS : base;
    }

    // ==================== 计划模式 ====================

    /**
     * 计划模式动态指令 —— 激活时追加到工具协作约定末尾。
     * 放在动态尾部而非 system prompt 固定前缀，避免模式切换破坏前缀缓存稳定性。
     */
    private static final String PLAN_MODE_INSTRUCTIONS = """
            ## Plan Mode（当前处于计划模式）

            - 仅只读工具可用：写入/修改/执行类工具已从工具列表移除，任何此类调用都会被直接拒绝
            - 不要尝试修改文件、执行命令等任何改变操作，也不要尝试绕过此限制
            - 先用只读工具充分探索，理解现状、明确目标、影响面与风险
            - 探索完成后用 `submit_plan` 工具提交完整执行计划供用户审查，然后向用户简要总结计划要点并结束本轮
            - 用户批准计划后系统会退出计划模式并按计划执行
            """;

    @Override
    public boolean isPlanMode() {
        return planMode;
    }

    /**
     * 切换计划模式（会话级状态，仅影响本循环）。
     * <p>切换在下一步立即生效：工具列表过滤为只读集合、非只读调用被拒绝、
     * 计划模式指令注入工具约定。持久化与事件通知由上层（LoopraAgent）负责。</p>
     */
    public void setPlanMode(boolean enabled) {
        this.planMode = enabled;
    }

    /**
     * 保存 submit_plan 提交的任务计划，并通过 plan_submitted 事件通知前端。
     */
    @Override
    public void submitPlan(String planMarkdown) {
        this.pendingPlan = planMarkdown;
        emitPlanPersistence(planMarkdown);
        ONode data = ONode.ofJson("{}").asObject();
        data.set("plan", planMarkdown != null ? planMarkdown : "");
        safeOutput("planSubmitted", () -> output.sendEvent("plan_submitted", data.toJson()));
    }

    /** 获取待审查计划（不移除）。 */
    public String getPendingPlan() {
        return pendingPlan;
    }

    /** 静默恢复持久化的待审查计划，不触发事件或重复写盘。 */
    public void restorePendingPlan(String planMarkdown) {
        this.pendingPlan = planMarkdown;
    }

    /** 清除待审查计划并同步持久化。 */
    public void clearPendingPlan() {
        this.pendingPlan = null;
        emitPlanPersistence(null);
    }

    /** 取出并清空待审查计划（/execute 批准时调用）。 */
    public String consumePendingPlan() {
        String plan = pendingPlan;
        clearPendingPlan();
        return plan;
    }

    private void emitPlanPersistence(String planMarkdown) {
        if (cutinEngine != null) {
            String eventType = planMarkdown == null
                    ? LoopraPlanHost.PLAN_CLEARED
                    : LoopraPlanHost.PLAN_SUBMITTED;
            String loopId = activeCutinHandle != null
                    ? activeCutinHandle.id()
                    : "plan";
            cutinEngine.events().emit(new LoopEvent(
                    eventType,
                    loopId,
                    null,
                    Map.of("plan", planMarkdown == null ? "" : planMarkdown)
            ));
            return;
        }
        persistPendingPlan(planMarkdown);
    }

    @Override
    public void persistPendingPlan(String planMarkdown) {
        SessionUsageSink sink = sessionUsageSink;
        if (sink == null) return;
        try {
            sink.persistPendingPlan(planMarkdown);
        } catch (Exception e) {
            log.warn("[plan] 持久化待审查计划失败: {}", e.getMessage());
        }
    }

    /**
     * 将工具列表过滤为只读集合（不修改注册表及其缓存，返回新节点）。
     * 注册表中找不到对应 FunctionTool 的条目一律剔除（保守策略）。
     */
    private ONode filterReadOnlyTools(ONode tools) {
        if (tools == null || !tools.isArray()) {
            return tools;
        }
        Map<String, FunctionTool> available = registry.all();
        ONode filtered = ONode.ofJson(tools.toJson()).asArray();
        filtered.getArray().removeIf(item -> {
            String name = item.get("function").get("name").getString();
            FunctionTool tool = name != null ? available.get(name) : null;
            return tool == null || !ToolMetadata.isReadOnly(tool);
        });
        return filtered;
    }

    /**
     * 获取工具注册表实例。
     */
    /**
     * 从当前上下文重新计算 token 构成。
     * <p>供历史会话在未执行新一轮模型请求时按持久化消息生成预估。</p>
     */
    public ContextTokenEstimate estimateCurrentContext() {
        ONode tools = refreshTools();
        ContextTokenEstimate estimate = ContextTokenEstimator.estimate(
                ctx.buildMessages(), tools, currentToolInstructions());
        lastContextEstimate = estimate;
        return estimate;
    }

    public StormBreaker stormBreaker() {
        return stormBreaker;
    }

    public ReasonBreaker reasonBreaker() {
        return reasonBreaker;
    }

    public void markCutinStormSuppressed() {
        cutinSuppression.set(true);
    }

    @Override
    public void beginCutinLoop() {
        stormBreaker.reset();
        reasonBreaker.reset();
        resetUserAbort();
    }

    @Override
    public void endCutinLoop() {
        cutinSuppression.set(false);
    }

    @Override
    public void reportCutinUsage(Usage usage) {
        propagateUsage(usage);
    }

    @Override
    public String sessionAffinity() {
        return sessionId;
    }

    @Override
    public void emitTokenSpeed(long completionTokens, double tokensPerSecond, double avgTokensPerSecond, boolean done) {
        safeOutputDebug("tokenSpeed", () -> {
            if (output instanceof site.sorghum.loopra.web.service.SseAgentOutput sse) {
                sse.onTokenSpeed(completionTokens, tokensPerSecond, avgTokensPerSecond, done);
            } else {
                output.sendEvent("token_speed", "{\"completionTokens\":" + completionTokens + ",\"tokensPerSecond\":" + tokensPerSecond + ",\"avgTokensPerSecond\":" + avgTokensPerSecond + ",\"done\":" + done + "}");
            }
        });
    }

    @Override
    public void emitTokenSpeed(long completionTokens, double tokensPerSecond, boolean done) {
        emitTokenSpeed(completionTokens, tokensPerSecond, tokensPerSecond, done);
    }

    @Override
    public void injectReasonBreakReminder() {
        ctx.addUser("[ReasonBreaker] 检测到思考循环，已提前终止本轮推理。请停止当前思路，尝试不同的方法。");
    }

    @Override
    public boolean continueAfterExit(DefaultLoopContext context) {
        String reason = String.valueOf(context.variables().getOrDefault("loopraExitReason", ""));
        return switch (reason) {
            case "finish" -> {
                String requested = takeFinishContentIfAllowed();
                if (requested != null) {
                    context.putVariable("loopraTurnResult", requested);
                    yield false;
                }
                yield true;
            }
            case "no_tool" -> decideNoToolExit(context);
            default -> false;
        };
    }

    private boolean decideNoToolExit(DefaultLoopContext context) {
        String candidate = String.valueOf(
                context.variables().getOrDefault("loopraNoToolCandidate", ""));
        Object rawStreak = context.variables().getOrDefault("loopraNoToolStreak", 1);
        int streak = rawStreak instanceof Number number ? number.intValue() : 1;
        GoalGuard.GoalView openGoal = loadOpenGoalQuietly();
        boolean shouldExit = (openGoal != null && !openGoal.requiresAgentWork())
                || (terminateOnNoToolCall() && openGoal == null)
                || streak >= 3;
        if (shouldExit) {
            String prefix = openGoal != null ? "[Goal 尚未关闭，后续回合可继续]\n" : "";
            context.putVariable("loopraTurnResult", prefix + candidate);
            return false;
        }
        ctx.addUser(openGoal != null
                ? "[Goal guard] Goal 尚未关闭。请继续执行当前步骤，记录证据，并调用 goal_complete 后再结束。"
                : FinishTool.TIPS);
        return true;
    }

    private GoalGuard.GoalView loadOpenGoalQuietly() {
        try {
            return loadOpenGoal();
        } catch (Exception exception) {
            log.warn("[goal] 读取当前 Goal 失败: {}", exception.getMessage());
            return null;
        }
    }

    @Override
    public int maxContextRecoveries() {
        return MAX_CONTEXT_RECOVERIES;
    }

    @Override
    public boolean compactAfterContextOverflow(int recoveryAttempt) {
        return tryCompactAfterContextOverflow(recoveryAttempt);
    }

    @Override
    public void afterTurn() {
        SessionUsageSink sink = sessionUsageSink;
        if (sink != null) {
            try {
                sink.afterTurn();
            } catch (Exception exception) {
                log.warn("[session] 回合提交回调失败: {}", exception.getMessage());
            }
        }
    }

    @Override
    public void beforeTurn(String userMessage) {
        if (userMessage.isBlank() || sessionUsageSink == null) {
            return;
        }
        try {
            String sessionId = sessionUsageSink.beforeTurn(userMessage);
            if (sessionId != null && !sessionId.isBlank()) {
                setSessionId(sessionId);
            }
        } catch (Exception exception) {
            log.warn("[session] 回合开始回调失败: {}", exception.getMessage());
        }
    }

    @Override
    public UserMessage sanitizePreflightMessage(UserMessage message) {
        return UserMessageSanitizer.sanitize(message, modelProvider, workingDirectory());
    }

    @Override
    public void appendPreflightUserMessage(UserMessage message) {
        ctx.addUser(message);
    }

    @Override
    public void clearSuspendedCutinState() {
        suspendedCutinHandle = null;
        suspendedCutinContext = null;
        suspendedCutinState = null;
    }

    @Override
    public HitlState hitlState() {
        return hitlManager.getState();
    }

    @Override
    public boolean hasSuspendedCutin() {
        return suspendedCutinHandle != null && suspendedCutinContext != null;
    }

    @Override
    public boolean hasSandboxPending() {
        return hitlManager.hasSandboxPending();
    }

    @Override
    public String resumeApprovedTurn() throws IOException {
        return hitlManager.hasSandboxPending()
            ? resumeCutinSandboxHITL()
            : resumeCutinHITL();
    }

    @Override
    public String rejectTurn() {
        return hitlManager.hasSandboxPending()
            ? denyCutinSandboxHITL()
            : denyCutinHITL();
    }

    @Override
    public String suspendSandboxHITLIfPending(DefaultLoopContext context) {
        if (hitlManager.getState() != HitlState.PENDING || !hitlManager.hasSandboxPending()) {
            return null;
        }
        Object resumeState = context.artifacts().get("loopraSandboxResume");
        if (resumeState instanceof HitlManager.PendingSandboxState sandboxState) {
            hitlManager.storeSandboxContent(sandboxState.content(), sandboxState.reasoningContent());
        } else if (context.artifacts().get("loopraModel") instanceof CutinStreamSnapshot snapshot) {
            hitlManager.storeSandboxContent(snapshot.content(), snapshot.reasoningContent());
        }
        return hitlManager.interceptForSandboxHITL(output);
    }

    @Override
    public void applySelfCorrection(DefaultLoopContext context, ToolExecutionResult result) {
        LoopState state = runningCutinState;
        int updated = handleSelfCorrection(
                result.toolResults(), result.anySuppressed(),
                state == null ? 0 : state.selfCorrectionAttempts);
        if (updated < 0) {
            String fallback = "所有工具调用均被风暴断路器抑制，无法继续执行。请换用其他方式完成任务。";
            ctx.addAssistant(fallback, null, null);
            context.putVariable("loopraExitReason", "self_correction");
            context.putVariable("loopraTurnResult", fallback);
            return;
        }
        if (state != null) {
            state.selfCorrectionAttempts = updated;
        }
    }

    /**
     * cutin 扩展点使用的上下文折叠入口：复用 Loopra 原有折叠策略，
     * 折叠结果回写 cutin context，由 BEFORE_MODEL 拦截器交给模型网关。
     */
    public PreparedMessages prepareCutinMessages(DefaultLoopContext context, int step) {
        try {
            ONode tools = refreshTools();
            PreparedMessages prepared = prepareMessages(step, tools);
            context.replaceMessages(CutinMessageBridge.toCutin(prepared.messages()));
            return prepared;
        } catch (IOException exception) {
            log.warn("[cutin] BEFORE_MODEL 折叠失败，按当前上下文继续: {}", exception.getMessage());
            List<ChatMessage> fallback = ctx.buildMessages();
            try {
                ONode tools = refreshTools();
                lastContextEstimate = ContextTokenEstimator.estimate(fallback, tools, currentToolInstructions());
            } catch (Exception ignored) {
            }
            return new PreparedMessages(fallback, false);
        }
    }

    public site.sorghum.cutin.core.tool.ToolResult rejectCutinTool(
            site.sorghum.cutin.core.tool.ToolCall call,
            String message,
            String reason) {
        String result = rejectedToolResult(message, reason);
        safeListener("toolResult", () -> listener.onToolResult(call.toolId(), result));
        safeOutputDebug("toolResult", () -> output.onToolResult(call.toolId(), result));
        return site.sorghum.cutin.core.tool.ToolResult.failure(call.id(), result);
    }

    /**
     * cutin AFTER_MODEL 使用的 HITL 入口。返回非空文本时表示循环应暂停，
     * 文本即向用户展示的审批提示。
     */
    public String interceptHITLFromCutin(ModelResponse response) {
        if (response == null || response.message() == null) {
            return null;
        }
        ONode toolCalls = toolCallsFromCutinMessage(response.message());
        if (toolCalls == null || !toolCalls.isArray() || toolCalls.getArray().isEmpty()) {
            return null;
        }
        String content = response.message().content();
        String reasoning = metadataString(response.message(), "reasoning_content");
        if (!hitlManager.isHitlMode() || !hitlManager.requiresHITL(toolCalls)) {
            return null;
        }

        if (toolCallValidator.enabled()) {
            ToolCallValidator.Decision decision = validateHITLToolCalls(toolCalls);
            if (decision.requiresHuman()) {
                hitlManager.setSandboxPending(toolCalls, decision.reason());
                hitlManager.storeSandboxContent(content, reasoning);
                return hitlManager.interceptForSandboxHITL(output);
            }
            if (decision.failed()) {
                safeOutput("toolValidator", () -> output.onLog(LogLevel.WARN,
                        "[tool-validator] " + decision.reason() + "，回退人工审批"));
                String hitlPrompt = hitlManager.interceptForHITL(
                        toolCalls, content, reasoning, output);
                return hitlPrompt;
            }
            if (!decision.allowed()) {
                String denyMsg = "工具调用未通过 AI 审批: " + decision.reason();
                safeOutput("toolValidator", () -> output.onLog(LogLevel.WARN,
                        "[tool-validator] " + denyMsg));
                ctx.addAssistant(denyMsg, null, null);
                return denyMsg;
            }
            safeOutput("toolValidator", () -> output.onLog(LogLevel.INFO,
                    "[tool-validator] AI 审批通过，继续执行工具调用"));
            return null;
        }
        return hitlManager.interceptForHITL(toolCalls, content, reasoning, output);
    }

    private static ONode toolCallsFromCutinMessage(site.sorghum.cutin.core.context.Message message) {
        ONode calls = ONode.ofJson("[]").asArray();
        for (site.sorghum.cutin.core.tool.ToolCall call : message.toolCalls()) {
            ONode item = calls.addNew().asObject();
            item.set("id", call.id());
            item.set("type", "function");
            ONode function = item.getOrNew("function");
            function.set("name", call.toolId());
            function.set("arguments", ONode.ofBean(call.arguments()).toJson());
        }
        return calls;
    }

    private static String metadataString(site.sorghum.cutin.core.context.Message message, String key) {
        Object value = message.metadata(key);
        return value == null ? null : String.valueOf(value);
    }

    private String buildToolInstructions() {
        // 静态文案与 LoopraPromptPlugin 的 tool-contract 切片共用 ToolContract 单一来源
        return ToolContract.build(terminateOnNoToolCall(), currentGoalInstruction());
    }

    private String currentGoalInstruction() {
        if (!goalGuardEnabled || goalGuard == null) return "";
        try {
            return goalGuard.instruction(loadOpenGoal());
        } catch (Exception e) {
            log.warn("[goal] 读取当前 Goal 失败", e);
            return "## Goal 状态不可用\n持久化 Goal 暂时无法读取。不要声称目标已完成；可以说明错误并结束当前回合。"
                    + "若持续无法读取，可提示用户执行 `/goal reset` 清除损坏快照后重试。";
        }
    }

    private GoalGuard.GoalView loadOpenGoal() throws IOException {
        if (goalGuard == null || sessionId == null || sessionId.isBlank()
                || registry.getEnvironment() == null || registry.getEnvironment().stateRoot() == null) {
            return null;
        }
        Path stateRoot = registry.getEnvironment().stateRoot();
        return goalGuard.openGoal(stateRoot, sessionId);
    }

    private String takeFinishContentIfAllowed() {
        String requested = finishContent;
        finishContent = null;
        if (requested == null || !goalGuardEnabled || goalGuard == null) return requested;
        try {
            GoalGuard.GoalView goal = loadOpenGoal();
            if (goal == null || !goal.requiresAgentWork()) return requested;
            String reminder = "[Goal guard] 当前 Goal 仍在推进：" + goal.title()
                    + "（" + goal.progressText() + "）。请继续当前步骤并调用 goal_complete；"
                    + "只有确实需要用户输入或外部状态变化时才调用 goal_block。";
            injectUserMessage(reminder);
            safeOutput("goalFinishGuard", () -> output.onLog(LogLevel.WARN, reminder));
            modelProvider.resetStreamAbort();
            return null;
        } catch (Exception e) {
            String reminder = "[Goal guard] 无法读取持久化 Goal 状态，已拒绝 finish：" + e.getMessage()
                    + "。若持续无法读取，可提示用户执行 `/goal reset` 清除损坏快照后重试。";
            injectUserMessage(reminder);
            safeOutput("goalFinishGuard", () -> output.onLog(LogLevel.ERROR, reminder));
            modelProvider.resetStreamAbort();
            return null;
        }
    }

    private void discardFinishRequest() {
        finishContent = null;
        modelProvider.resetStreamAbort();
    }

    // ==================== 主入口：run() ====================

    /**
     * 执行一个用户回合，返回最终的 assistant content。
     * <p>
     * 用户消息会被追加到上下文，工具调用结果也会累积。
     * 下一个回合调用时，上下文已包含上一轮的全部消息。
     * </p>
     */
    public String run(UserMessage userMessage) throws IOException {
        if (cutinEngine == null) {
            throw new IllegalStateException("[loop] Loopra 主循环已全部切换到 cutin，必须初始化 cutin 引擎");
        }
        // ---- 标记运行中，防止巡检线程并发冲突 ----
        running.set(true);
        try {
            return runCutinMainLoop(userMessage);
        } finally {
            running.set(false);
        }
    }

    /**
     * 将 Loopra 主循环注册为 cutin 程序执行。
     * 模型与工具分属独立 cutin 节点，业务规则全部由
     * {@link LoopraModelPolicyPlugin} / {@link LoopraToolPolicyPlugin} 注册的
     * cutin 拦截点驱动。
     */
    private String runCutinMainLoop(UserMessage userMessage) throws IOException {
        if (ctx == null) {
            throw new IOException("[loop] cutin 主循环需要 ConversationContext");
        }
        LoopState state = new LoopState();
        DefaultLoopContext cutinContext = cutinEngine.newContext(
            UUID.randomUUID().toString(),
            CutinMessageBridge.toCutin(ctx.buildMessages()),
            Map.of(
                "sessionId", sessionId == null ? "" : sessionId
            ),
            Budget.unlimited(),
            workingDirectory()
        );
        if (userMessage != null) {
            cutinContext.putArtifact(LoopraPreflight.INPUT_ARTIFACT, userMessage);
        }
        LoopProgram program = LoopProgram.builder("loopra-agent-loop")
            .node(LoopraPreflight.SANITIZE_NODE, NodeType.CODE, "按模型能力清洗用户消息",
                context -> cutinPlugins.getBean(LoopraMessageSanitizerPlugin.class).execute(context))
            .node(LoopraPreflight.HITL_NODE, NodeType.CODE, "处理上一轮 HITL 审批或拒绝",
                context -> cutinPlugins.getBean(LoopraHitlPlugin.class).execute(context))
            .node(LoopraPreflight.USER_MESSAGE_NODE, NodeType.CODE, "追加清洗后的用户消息",
                context -> cutinPlugins.getBean(LoopraUserMessagePlugin.class).execute(context))
            .node("model", NodeType.MODEL, "调用模型并处理流式响应",
                context -> modelStep((DefaultLoopContext) context, state))
            .node("tool", NodeType.TOOL, "执行模型请求的工具",
                context -> toolStep((DefaultLoopContext) context, state))
            .node(LoopraPreflight.OUTPUT_NODE, NodeType.OUTPUT, "输出本轮最终结果",
                ignored -> StepResult.Exit.INSTANCE)
            .next(LoopraPreflight.SANITIZE_NODE, LoopraPreflight.HITL_NODE, "清洗完成后检查 HITL")
            .next(LoopraPreflight.HITL_NODE, LoopraPreflight.USER_MESSAGE_NODE, "无审批短路时继续")
            .next(LoopraPreflight.USER_MESSAGE_NODE, "model", "消息写入上下文后请求模型")
            .next("model", "tool", "模型产生工具调用")
            .next("tool", "model", "工具结果返回模型继续推理")
            .start(LoopraPreflight.SANITIZE_NODE)
            .build();

        log.info("[loop] 开始 cutin 主循环\n{}",program.prettyPrint());
        return runCutinLoop(program, cutinContext, state);
    }

    private String runCutinLoop(
            LoopProgram program,
            DefaultLoopContext cutinContext,
            LoopState state
    ) throws IOException {
        LoopHandle handle = cutinEngine.run(program, cutinContext);
        activeCutinHandle = handle;
        runningCutinState = state;
        try {
            LoopResult result = handle.result().join();
            return finishCutinResult(state, cutinContext, handle, result);
        } finally {
            activeCutinHandle = null;
            runningCutinState = null;
        }
    }

    private String finishCutinResult(LoopState state, DefaultLoopContext cutinContext,
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
            String last = ctx.getLastAssistantContent();
            return last != null && !last.isEmpty() ? last : "⏹️ 已停止生成";
        }
        if (result.status() == LoopResult.Status.SUSPENDED) {
            suspendedCutinHandle = handle;
            suspendedCutinContext = cutinContext;
            suspendedCutinState = state;
            return result.message() != null && !result.message().isBlank()
                    ? result.message()
                    : "⏸️ 已暂停，等待外部输入";
        }
        throw new IOException("[loop] cutin loop failed: " + result.message());
    }

    private String resumeCutinHITL() throws IOException {
        hitlManager.drainPendingHITL();
        hitlManager.resetState();
        LoopHandle handle = suspendedCutinHandle;
        DefaultLoopContext context = suspendedCutinContext;
        LoopState state = suspendedCutinState;
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
        CutinStreamSnapshot snapshot = cutinSnapshotFromResponse(response);
        LoopSnapshot base = handle.snapshot();
        ReentryRequest request = new ReentryRequest(
                "tool",
                base.stateVersion(),
                Map.of(),
                Map.of("loopraModel", snapshot),
                "hitl-approved");
        activeCutinHandle = handle;
        try {
            LoopResult result = handle.reenter(request).join();
            return finishCutinResult(state, context, handle, result);
        } finally {
            activeCutinHandle = null;
        }
    }

    private String denyCutinHITL() {
        hitlManager.drainPendingHITL();
        hitlManager.resetState();
        suspendedCutinHandle = null;
        suspendedCutinContext = null;
        suspendedCutinState = null;
        discardFinishRequest();
        String denyMsg = "工具调用已被用户拒绝。";
        ctx.addAssistant(denyMsg, null, null);
        return denyMsg;
    }

    private String resumeCutinSandboxHITL() throws IOException {
        HitlManager.PendingSandboxState sandboxState = hitlManager.drainSandboxHITL();
        hitlManager.resetState();
        LoopHandle handle = suspendedCutinHandle;
        DefaultLoopContext context = suspendedCutinContext;
        LoopState state = suspendedCutinState;
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
        activeCutinHandle = handle;
        try {
            LoopResult result = handle.reenter(request).join();
            return finishCutinResult(state, context, handle, result);
        } finally {
            activeCutinHandle = null;
        }
    }

    private String denyCutinSandboxHITL() {
        HitlManager.PendingSandboxState sandboxState = hitlManager.drainSandboxHITL();
        hitlManager.resetState();
        suspendedCutinHandle = null;
        suspendedCutinContext = null;
        suspendedCutinState = null;
        discardFinishRequest();
        if (sandboxState != null) {
            List<ToolCallEntry> tcList = parseToolCallsFromONode(sandboxState.toolCalls());
            ctx.addAssistant(sandboxState.content(), tcList, sandboxState.reasoningContent());
        }
        String denyMsg = "沙箱越界已被用户拒绝。";
        ctx.addAssistant(denyMsg, null, null);
        return denyMsg;
    }

    private static CutinStreamSnapshot cutinSnapshotFromResponse(ModelResponse response) {
        Object thinking = response.message().metadata("thinking_blocks");
        return new CutinStreamSnapshot(
                response.message().content(),
                metadataString(response.message(), "reasoning_content"),
                response.message().toolCalls(),
                thinking instanceof List<?> list ? list.stream().map(String::valueOf).toList() : List.of(),
                response.usage() == null ? Usage.ZERO : response.usage(),
                null,
                metadataString(response.message(), "response_reasoning"));
    }

    private StepResult modelStep(DefaultLoopContext context, LoopState state) {
        try {
            return doModelStep(context, state);
        } catch (IOException exception) {
            state.ioError = exception;
            return new StepResult.Fail(exception.getMessage());
        }
    }

    private StepResult doModelStep(DefaultLoopContext context, LoopState state) throws IOException {
        Runnable extSource = externalAbortSource;
        if (extSource != null) {
            extSource.run();
        }
        if (userAbortRequested || Thread.currentThread().isInterrupted()) {
            if (!userAbortRequested) {
                userAbortRequested = true;
            }
            logAbort();
            String lastContent = ctx.getLastAssistantContent();
            state.result = lastContent != null && !lastContent.isEmpty()
                    ? lastContent
                    : "⏹️ 已停止生成";
            return StepResult.Exit.INSTANCE;
        }

        int step = state.step;
        state.step = step + 1;
        context.putVariable("loopraStep", step);

        Map<String, Object> requestOptions = new HashMap<>();
        ModelCallRequest request = new ModelCallRequest(
            modelProvider.effectiveModel(),
            context.messages(),
            context.tools().definitions(),
            requestOptions
        );
        CutinStreamSnapshot snapshot;
        try (Stream<StreamChunk> chunks = context.models().stream(request, context)) {
            snapshot = collectCutinStream(chunks);
        }

        Runnable extSource2 = externalAbortSource;
        if (extSource2 != null) {
            extSource2.run();
        }
        if (userAbortRequested || Thread.currentThread().isInterrupted()) {
            safeOutput("abort", () -> output.onLog(LogLevel.INFO,
                    "[abort] 用户请求中断（模型流结束后检测），停止推理循环"));
            state.result = handleAbortAfterStream(snapshot.toStreamResult());
            return StepResult.Exit.INSTANCE;
        }

        if (snapshot.error()) {
            if (ModelApiError.isContextLengthExceeded(snapshot.errorMessage())) {
                safeOutput("streamError", () -> output.onError("[stream error] " + snapshot.errorMessage()));
            }
            String detail = snapshot.errorMessage() != null ? ": " + snapshot.errorMessage() : "";
            throw new IOException("[stream] API error during streaming" + detail);
        }
        safeOutputDebug("contentComplete", output::onContentComplete);
        context.addUsage(snapshot.usage());

        ONode toolCalls = scavengeToolCalls(snapshot.toolCalls(), snapshot.reasoningContent(), snapshot.content());
        boolean hasToolCalls = toolCalls != null && toolCalls.isArray() && !toolCalls.getArray().isEmpty();
        if (!hasToolCalls) {
            ChatMessage noTool = ChatMessage.assistant(snapshot.content(), null, snapshot.reasoningContent());
            if (snapshot.responseReasoning() != null) {
                noTool.setResponseReasoning(snapshot.responseReasoning());
            }
            if (snapshot.thinkingBlocks() != null && !snapshot.thinkingBlocks().isEmpty()) {
                noTool.setThinkingBlocks(new ArrayList<>(snapshot.thinkingBlocks()));
            }
            ctx.addAssistant(noTool.getContent(), noTool.getToolCalls(), noTool.getReasoningContent(),
                    noTool.getThinkingBlocks(), List.of());
            if (noTool.getResponseReasoning() != null) {
                // 兼容 ConversationContext 内部用特定签名持久化
                for (int i = ctx.getHistory().size() - 1; i >= 0; i--) {
                    ChatMessage m = ctx.getHistory().get(i);
                    if (m.isAssistant() && m.getResponseReasoning() == null) {
                        m.setResponseReasoning(noTool.getResponseReasoning());
                        break;
                    }
                }
            }
            try {
                if (goalGuardEnabled && goalGuard != null) {
                    loadOpenGoal();
                }
            } catch (Exception e) {
                String reminder = "[Goal guard] 无法读取持久化 Goal 状态：" + e.getMessage()
                        + "。若持续无法读取，可提示用户执行 `/goal reset` 清除损坏快照后重试。";
                safeOutput("goalRead", () -> output.onLog(LogLevel.ERROR, reminder));
                String content = snapshot.content() == null ? "" : snapshot.content();
                context.putVariable("loopraExitReason", "goal_error");
                context.putVariable("loopraTurnResult",
                        reminder + (content.isBlank() ? "" : "\n" + content));
                return StepResult.Exit.INSTANCE;
            }
            int streak = state.noToolCallStreak + 1;
            state.noToolCallStreak = streak;
            log.warn("[loop] 第 {} 次无工具调用，累积无工具轮数: {}", step, streak);
            context.putVariable("loopraNoToolStreak", streak);
            context.putVariable("loopraNoToolCandidate",
                    snapshot.content() == null ? "" : snapshot.content());
            context.putVariable("loopraExitReason", "no_tool");
            return StepResult.Exit.INSTANCE;
        }

        state.noToolCallStreak = 0;
        context.putArtifact("loopraModel", snapshot.withToolCalls(toolCalls));
        return new StepResult.Goto("tool");
    }

    private StepResult toolStep(DefaultLoopContext context, LoopState state) {
        if (context.artifacts().get("loopraSandboxResume") instanceof HitlManager.PendingSandboxState sandboxState) {
            return replaySandboxToolStep(context, sandboxState);
        }
        CutinStreamSnapshot snapshot = (CutinStreamSnapshot) context.artifacts().get("loopraModel");
        if (snapshot == null) {
            return new StepResult.Fail("missing loopra model snapshot");
        }
        ToolExecutionResult ter = executeToolCalls(snapshot.toolCalls(), context);
        InterceptionResult afterBatch = cutinEngine.intercept(
                InterceptPoint.AFTER_TOOL_BATCH,
                "tool",
                context,
                ter);
        if (afterBatch.decision().isSuspend()) {
            return new StepResult.Suspend(
                    afterBatch.decision().reason() == null
                            ? "sandbox hitl"
                            : afterBatch.decision().reason());
        }

        ChatMessage toolMsg = ChatMessage.assistant(snapshot.content(), ter.tcList(), snapshot.reasoningContent());
        if (snapshot.responseReasoning() != null) {
            toolMsg.setResponseReasoning(snapshot.responseReasoning());
        }
        if (snapshot.thinkingBlocks() != null && !snapshot.thinkingBlocks().isEmpty()) {
            toolMsg.setThinkingBlocks(new ArrayList<>(snapshot.thinkingBlocks()));
        }
        ctx.addAssistant(toolMsg.getContent(), toolMsg.getToolCalls(), toolMsg.getReasoningContent(),
                toolMsg.getThinkingBlocks(), ter.fileChanges());
        if (toolMsg.getResponseReasoning() != null) {
            for (int i = ctx.getHistory().size() - 1; i >= 0; i--) {
                ChatMessage m = ctx.getHistory().get(i);
                if (m.isAssistant() && m.getResponseReasoning() == null) {
                    m.setResponseReasoning(toolMsg.getResponseReasoning());
                    break;
                }
            }
        }
        for (ChatMessage tr : ter.toolResults()) {
            ctx.addToolResult(tr);
        }

        if (finishContent != null) {
            context.putVariable("loopraExitReason", "finish");
            return StepResult.Exit.INSTANCE;
        }
        if ("self_correction".equals(String.valueOf(
                context.variables().get("loopraExitReason")))) {
            return StepResult.Exit.INSTANCE;
        }
        return new StepResult.Goto("model");
    }

    private StepResult replaySandboxToolStep(DefaultLoopContext context,
                                             HitlManager.PendingSandboxState sandboxState) {
        List<ToolCallEntry> tcList = parseToolCallsFromONode(sandboxState.toolCalls());
        ctx.addAssistant(sandboxState.content(), tcList, sandboxState.reasoningContent());
        reasonBreaker.reset();
        stormBreaker.reset();
        resetUserAbort();

        ToolExecutionResult ter = executeToolCalls(sandboxState.toolCalls(), context);
        InterceptionResult afterBatch = cutinEngine.intercept(
                InterceptPoint.AFTER_TOOL_BATCH,
                "tool",
                context,
                ter);
        if (afterBatch.decision().isSuspend()) {
            return new StepResult.Suspend(
                    afterBatch.decision().reason() == null
                            ? "sandbox hitl"
                            : afterBatch.decision().reason());
        }
        ctx.setLatestAssistantFileChanges(ter.fileChanges());
        for (ChatMessage tr : ter.toolResults()) {
            ctx.addToolResult(tr);
        }
        if (finishContent != null) {
            context.putVariable("loopraExitReason", "finish");
            return StepResult.Exit.INSTANCE;
        }
        if ("self_correction".equals(String.valueOf(
                context.variables().get("loopraExitReason")))) {
            return StepResult.Exit.INSTANCE;
        }
        return new StepResult.Goto("model");
    }

    private static CutinStreamSnapshot collectCutinStream(Stream<StreamChunk> chunks) {
        StringBuilder content = new StringBuilder();
        StringBuilder reasoning = new StringBuilder();
        java.util.List<site.sorghum.cutin.core.tool.ToolCall> toolCalls = new ArrayList<>();
        java.util.List<String> thinkingBlocks = new ArrayList<>();
        site.sorghum.cutin.core.context.Usage[] usage =
                {site.sorghum.cutin.core.context.Usage.ZERO};
        String[] error = {null};
        String[] responseReasoning = {null};
        chunks.forEach(chunk -> {
            if (chunk.content() != null) {
                content.append(chunk.content());
            }
            if (chunk.reasoning() != null) {
                reasoning.append(chunk.reasoning());
            }
            toolCalls.addAll(chunk.toolCalls());
            thinkingBlocks.addAll(chunk.thinkingBlocks());
            usage[0] = usage[0].add(chunk.usage());
            Object terminalError = chunk.metadata().get("error");
            if (terminalError != null && chunk.terminal()) {
                error[0] = String.valueOf(terminalError);
            }
            Object reasoningMeta = chunk.metadata().get("response_reasoning");
            if (reasoningMeta != null) {
                responseReasoning[0] = String.valueOf(reasoningMeta);
            }
            Object reasoningContent = chunk.metadata().get("reasoning_content");
            if (reasoningContent != null && reasoning.length() == 0) {
                reasoning.append(String.valueOf(reasoningContent));
            }
        });
        String reasoningStr = reasoning.length() == 0 ? null : reasoning.toString();
        if (responseReasoning[0] != null) {
            try {
                org.noear.snack4.ONode item = org.noear.snack4.ONode.ofJson(responseReasoning[0]);
                org.noear.snack4.ONode summary = item.get("summary");
                if (summary != null && summary.isArray()) {
                    StringBuilder sb = new StringBuilder();
                    for (org.noear.snack4.ONode part : summary.getArray()) {
                        String text = part.get("text").getString();
                        if (text != null) sb.append(text);
                    }
                    if (sb.length() > 0) {
                        reasoningStr = sb.toString();
                    }
                }
            } catch (RuntimeException ignored) {
            }
        }
        return new CutinStreamSnapshot(
            content.length() == 0 ? null : content.toString(),
            reasoningStr,
            toolCalls,
            thinkingBlocks,
            usage[0],
            error[0],
            responseReasoning[0]
        );
    }

    /**
     * cutin 路径下的用量上报：统一从这里出口，
     * 否则会话的 lastPromptTokens / 上下文长度展示和用量统计不会更新。
     */
    private void propagateUsage(site.sorghum.cutin.core.context.Usage usage) {
        int promptTokens = Math.toIntExact(usage.promptTokens());
        int completionTokens = Math.toIntExact(usage.completionTokens());
        int totalTokens = promptTokens + completionTokens;
        int cacheHit = Math.toIntExact(usage.cacheReadTokens());
        int cacheMiss = Math.toIntExact(usage.cacheMissTokens());
        lastPromptTokens = promptTokens;
        if (sessionUsageSink != null) {
            sessionUsageSink.updateLastPromptTokens(promptTokens);
        }
        String currentModel = modelProvider.getModel();
        safeListener("usage", () -> listener.onUsage(
                currentModel, promptTokens, completionTokens, totalTokens, cacheHit, cacheMiss));
        safeOutputDebug("usage", () -> output.onUsage(
                currentModel, promptTokens, completionTokens, totalTokens, cacheHit, cacheMiss));
    }

    private record CutinStreamSnapshot(
        String content,
        String reasoningContent,
        java.util.List<site.sorghum.cutin.core.tool.ToolCall> cutinToolCalls,
        java.util.List<String> thinkingBlocks,
        site.sorghum.cutin.core.context.Usage usage,
        String errorMessage,
        String responseReasoning
    ) {
        boolean error() {
            return errorMessage != null;
        }

        ONode toolCalls() {
            ONode calls = ONode.ofJson("[]").asArray();
            for (site.sorghum.cutin.core.tool.ToolCall call : cutinToolCalls) {
                ONode item = calls.addNew().asObject();
                item.set("id", call.id());
                item.set("type", "function");
                ONode function = item.getOrNew("function");
                function.set("name", call.toolId());
                function.set("arguments", ONode.ofBean(call.arguments()).toJson());
            }
            return calls;
        }

        CutinStreamSnapshot withToolCalls(ONode scavengedToolCalls) {
            java.util.List<site.sorghum.cutin.core.tool.ToolCall> calls = new ArrayList<>();
            if (scavengedToolCalls != null && scavengedToolCalls.isArray()) {
                for (ONode node : scavengedToolCalls.getArray()) {
                    String id = node.get("id").getString();
                    ONode function = node.get("function");
                    String name = function.get("name").getString();
                    ONode arguments = function.get("arguments");
                    Map<String, Object> args = new HashMap<>();
                    if (arguments.isString()) {
                        try {
                            Object bean = ONode.ofJson(arguments.getString()).toBean(Map.class);
                            if (bean instanceof Map<?, ?> map) {
                                for (Map.Entry<?, ?> entry : map.entrySet()) {
                                    args.put(String.valueOf(entry.getKey()), entry.getValue());
                                }
                            }
                        } catch (RuntimeException ignored) {
                             // 格式错误的 JSON 保留空参数
                        }
                    } else if (arguments.isObject()) {
                        Object bean = arguments.toBean(Map.class);
                        if (bean instanceof Map<?, ?> map) {
                            for (Map.Entry<?, ?> entry : map.entrySet()) {
                                args.put(String.valueOf(entry.getKey()), entry.getValue());
                            }
                        }
                    }
                    calls.add(new site.sorghum.cutin.core.tool.ToolCall(id, name, args, id));
                }
            }
            return new CutinStreamSnapshot(content, reasoningContent, calls, thinkingBlocks, usage, errorMessage, responseReasoning);
        }

        StreamResult toStreamResult() {
            return new StreamResult(content, reasoningContent, toolCalls(), error(), errorMessage);
        }
    }

    private static final class LoopState {
        private int step;
        private int noToolCallStreak;
        private int selfCorrectionAttempts;
        private String result;
        private IOException ioError;
    }

    /**
     * 从 ONode 解析工具调用列表（不含暂存副作用）。
     */
    private static List<ToolCallEntry> parseToolCallsFromONode(ONode toolCalls) {
        List<ToolCallEntry> tcList = new ArrayList<>();
        if (toolCalls == null || !toolCalls.isArray()) return tcList;
        for (ONode tc : toolCalls.getArray()) {
            String tcId = tc.get("id").getString();
            ONode func = tc.get("function");
            String tcName = func.get("name").getString();
            if (tcName == null || tcName.isEmpty()) continue;
            String tcArgs = func.get("arguments").getString();
            if (tcArgs == null) tcArgs = "{}";
            String responseReasoning = tc.get("response_reasoning").getString();
            tcList.add(new ToolCallEntry(tcId, tcName, tcArgs, responseReasoning));
        }
        return tcList;
    }

    /**
     * 服务端确认上下文超限时执行一次兜底折叠，避免估算误差导致请求持续失败。
     * 不依赖压力阈值，直接按有效用量的 1/4、1/8 收缩保留预算。
     */
    private boolean tryCompactAfterContextOverflow(int recoveryAttempt) {
        try {
            ContextCompactionPolicy policy = ContextCompactionPolicy.from(config);
            ContextPressure pressure = ContextPressureMeter.measure(
                    ctx.buildMessages(), null, null, lastPromptTokens,
                    modelProvider.getMaxContextTokens(), policy);
            int retainTokens = Math.max(1,
                    pressure.effectivePromptTokens() / (4 * recoveryAttempt));
            if (!foldOldestRange(ctx.buildMessages(), retainTokens, "context")) {
                safeOutput("contextOverflow", () -> output.onLog(LogLevel.WARN,
                        "[context] 服务端确认上下文超限，但当前历史无法进一步折叠"));
                return false;
            }
            safeOutput("contextOverflow", () -> output.onLog(LogLevel.WARN,
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
        List<ChatMessage> history = ctx.getHistory();
        CompactionRangeSelector.Selection selection =
                CompactionRangeSelector.select(history, retainTokens);
        if (selection == null) {
            log.debug("[{}] 无可折叠范围（retainTokens={}）", logTag, retainTokens);
            return false;
        }
        List<ChatMessage> folded = ContextFolding.foldRange(messages, selection, modelProvider, workspace);
        if (folded.size() >= ctx.size()) {
            log.warn("[{}] 折叠未缩小历史，跳过本次折叠", logTag);
            return false;
        }
        ctx.compact(folded);
        lastPromptTokens = 0;
        lastContextEstimate = null;
        return true;
    }

    // ==================== 步骤 1: 消息准备 ====================

    static int effectivePromptTokens(int offlineEstimate, int lastPromptTokens) {
        return Math.max(offlineEstimate, lastPromptTokens);
    }

    private PreparedMessages prepareMessages(int step, ONode tools) throws IOException {
        List<ChatMessage> messages = ctx.buildMessages();
        MessageHealer.HealResult healResult = MessageHealer.heal(messages);
        messages = healResult.messages();

        String instr = currentToolInstructions();

        boolean foldedThisStep = false;
        ContextCompactionPolicy compactionPolicy = ContextCompactionPolicy.from(config);
        ContextPressure pressure = ContextPressureMeter.measure(
                messages, tools, instr, lastPromptTokens,
                modelProvider.getMaxContextTokens(), compactionPolicy);
        if (pressure.shouldCompact()) {
            ToolResultPruner.Config prunerConfig = ToolResultPruner.Config.from(config);
            ToolResultPruner.PruneResult pruned = ToolResultPruner.prune(ctx.getHistory(), prunerConfig);
            if (pruned.changed()) {
                ctx.compact(pruned.messages());
                foldedThisStep = true;
                lastPromptTokens = 0;
                messages = ctx.buildMessages();
                pressure = ContextPressureMeter.measure(
                        messages, tools, instr, lastPromptTokens,
                        modelProvider.getMaxContextTokens(), compactionPolicy);
                try {
                    output.onLog(LogLevel.INFO, "[prune] 裁剪 " + pruned.prunedCount()
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
                output.onLog(LogLevel.INFO, "[fold] 触发折叠(" + compactionAttempts + "/"
                        + maxCompactionAttempts + "): estimatedTokens="
                        + pressure.effectivePromptTokens()
                        + " threshold=" + pressure.thresholdTokens()
                        + " maxCtx=" + pressure.contextWindow());
            } catch (Exception e) {
                log.warn("[fold] output.onLog异常: {}", e.getMessage());
            }
            if (!foldOldestRange(messages, pressure.retainTokens(), "fold")) break;
            foldedThisStep = true;
            messages = ctx.buildMessages();
            pressure = ContextPressureMeter.measure(
                    messages, tools, instr, lastPromptTokens,
                    modelProvider.getMaxContextTokens(), compactionPolicy);
        }

        try {
            output.onLog(LogLevel.DEBUG, "step=" + step + " messages.size=" + messages.size()
                    + " lastPromptTokens=" + lastPromptTokens + " threshold=" + pressure.thresholdTokens());
        } catch (Exception e) {
            log.warn("[prepare] output.onLog异常: {}", e.getMessage());
        }

        // 工具协作约定已由 LoopraPromptPlugin 的 tool-contract(600) 切片注入，此处不再重复拼接；
        // 保留 instr 仅用于 token 估算的压缩阈值判断（与原语义一致）
        lastContextEstimate = ContextTokenEstimator.estimate(messages, tools, null);

        return new PreparedMessages(messages, foldedThisStep);
    }

    // ==================== 步骤 4: Scavenger 回收 ====================

    private ONode scavengeToolCalls(ONode toolCalls, String reasoningContent, String content) {
        boolean hasToolCalls = toolCalls != null && toolCalls.isArray() && !toolCalls.getArray().isEmpty();
        if (hasToolCalls) return toolCalls;
        if (reasoningContent == null && content == null) return toolCalls;

        List<Scavenger.ToolCall> scavenged = Scavenger.scavenge(reasoningContent, content, new ArrayList<>());
        if (scavenged.isEmpty()) return toolCalls;

        ONode fakeTcArray = ONode.ofJson("[]").asArray();
        for (Scavenger.ToolCall tc : scavenged) {
            ONode tcn = fakeTcArray.addNew();
            String idSuffix = tc.id() != null ? ""
                    : "_" + Integer.toHexString(tc.arguments().hashCode())
                    + "_" + System.nanoTime();
            tcn.set("id", tc.id() != null ? tc.id() : "scavenged_" + tc.name() + idSuffix);
            tcn.set("type", "function");
            ONode fn = tcn.getOrNew("function");
            fn.set("name", tc.name());
            fn.set("arguments", tc.arguments());
        }
        return fakeTcArray;
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
            cutinEngine.intercept(
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
            hitlManager.setSandboxPending(toolCalls, hitlEx.getDetails());
            safeOutput("hitl", () -> output.onLog(LogLevel.WARN,
                    "[hitl] 沙箱越界触发强制审批: " + hitlEx.getDetails()));
        }

        Path executionRoot = registry.getEnvironment() == null
                ? null : registry.getEnvironment().executionRoot();
        List<FileChange> fileChanges = drainFileChanges
                ? SessionFileChangeTracker.drain(executionRoot, getSessionId())
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
                safeOutput("tool", () -> output.onLog(LogLevel.WARN,
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
            safeListener("toolCall", () -> listener.onToolCall(finalTcName, finalTcArgs));
            safeOutputDebug("toolCall", () -> output.onToolCall(finalTcName, finalTcArgs));
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

    private DispatchResult dispatchToolCallsAsync(List<ONode> tcArray) {
        return dispatchToolCallsAsync(tcArray, null);
    }

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
                Runnable extAbort = externalAbortSource;
                if (extAbort != null) {
                    extAbort.run();
                }
                // 用户已中断 → 立即返回，不执行工具
                ToolExecutionControl control = controls[idx];
                if (userAbortRequested || control.isCancelled()) {
                    ONode tc = tcArray.get(idx);
                    String tcId = tc.get("id").getString();
                    return toolResult(tcId,
                            "{\"error\":\"用户已中断\",\"aborted\":true}");
                }

                currentToolControl.set(control);
                Path executionRoot = cutinContext == null
                        ? workingDirectory()
                        : cutinContext.workingDirectory() != null
                            ? cutinContext.workingDirectory()
                            : workingDirectory();
                SessionFileChangeTracker.bind(executionRoot, getSessionId());
                try {
                    ONode tc = tcArray.get(idx);
                    ToolCall toolCall = getToolCall(tc);
                    FunctionTool fc = registry.get(toolCall.getName());
                    // 拓展包/插件贡献的工具只注册在 cutin 视图（CutinToolRegistryView
                    // 外部注册区），存在性检查须同时覆盖两侧，避免“已注册却报工具不存在”。
                    if (fc == null && !registry.cutinRegistry().find(toolCall.getName()).isPresent()) {
                        String result = "工具不存在";
                        safeListener("toolResult", () -> listener.onToolResult(toolCall.getName(), result));
                        safeOutputDebug("toolResult", () -> output.onToolResult(toolCall.getName(), result));
                        return toolResult(toolCall.getId(), "工具不存在");
                    }

                    // 计划模式硬约束：非只读工具直接拒绝。
                    // 正常情况下写工具已从工具列表移除，此处兼容模型凭记忆幻觉调用的兑底；
                    // 仅存在于 cutin 视图的外部工具（fc == null）不受 legacy 策略约束，由 cutin 拦截链负责。
                    if (fc != null && cutinContext == null && planMode && !ToolMetadata.isReadOnly(fc)) {
                        String result = rejectedToolResult(
                                "当前处于计划模式，仅允许只读工具；本次调用已被拒绝。请继续使用只读工具探索，完成后用 submit_plan 提交计划。",
                                "plan_mode");
                        safeListener("toolResult", () -> listener.onToolResult(toolCall.getName(), result));
                        safeOutputDebug("toolResult", () -> output.onToolResult(toolCall.getName(), result));
                        return toolResult(toolCall.getId(), result);
                    }

                    String argumentsJson = toolCall.getArgumentsStr();
                    if (fc != null && cutinContext == null && !ToolMetadata.isStormExempt(fc)) {
                        boolean readOnly = ToolMetadata.isReadOnly(fc);
                        StormBreaker.SuppressResult suppression =
                                stormBreaker.inspect(toolCall.getName(), argumentsJson, readOnly);
                        if (suppression.suppressed()) {
                            anySuppressed.set(true);
                            String result = rejectedToolResult(suppression.reason(), "storm");
                            safeListener("toolResult", () -> listener.onToolResult(toolCall.getName(), result));
                            safeOutputDebug("toolResult", () -> output.onToolResult(toolCall.getName(), result));
                            return toolResult(toolCall.getId(), result);
                        }
                    }

                    // 收集工具调用上下文；终端工具通过 __cwd 获取实际执行目录。
                    ToolContext.setCurrentController(AgentLoop.this);
                    String executionPath = executionRoot == null
                            ? null
                            : executionRoot.toAbsolutePath().normalize().toString();
                    Path environmentStateRoot = registry.getEnvironment() == null
                            ? null
                            : registry.getEnvironment().stateRoot();
                    String statePath = environmentStateRoot != null
                            ? environmentStateRoot.toAbsolutePath().normalize().toString()
                            : executionPath;
                    HashMap<String, Object> extraMap = new HashMap<>();
                    extraMap.put("__cwd", executionPath);
                    extraMap.put("ctx", new ToolContext(
                            new HashMap<>(),
                            executionPath,
                            statePath,
                            this.getSessionId()
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
                                : registry.cutinRegistry().call(cutinCall, null);
                        String rawResult = cutinResult.ok()
                                ? String.valueOf(cutinResult.content())
                                : cutinResult.error();
                        ImageToolResult.ImageResult imageResult = ("read_image".equals(toolCall.getName())
                                || "browser_screenshot".equals(toolCall.getName()))
                                ? ImageToolResult.parseResult(rawResult) : null;
                        String result = imageResult == null ? rawResult : imageResult.summary();
                        safeListener("toolResult", () -> listener.onToolResult(toolCall.getName(), result));
                        safeOutputDebug("toolResult", () -> output.onToolResult(toolCall.getName(), result));
                        ChatMessage toolMessage = imageResult == null ? ChatMessage.tool(toolCall.getId(), result)
                                : ChatMessage.toolWithImage(toolCall.getId(), result,
                                imageResult.dataUri(), imageResult.detail());
                        return timedToolResult(toolMessage, toolStartedAt);
                    } catch (HitlRequiredException e) {
                        hitlRef.compareAndSet(null, e);
                        return toolResult(toolCall.getId(),
                                "[HITL_PENDING:" + e.getReason() + "] " + e.getDetails());
                    } catch (Throwable e) {
                        String result = e.getMessage();
                        safeListener("toolResult", () -> listener.onToolResult(toolCall.getName(), result));
                        safeOutputDebug("toolResult", () -> output.onToolResult(toolCall.getName(), result));
                        return timedToolResult(toolCall.getId(), result, toolStartedAt);
                    }
                } finally {
                    CutinFunctionToolBridge.clearCallContext();
                    SessionFileChangeTracker.clearBinding();
                    currentToolControl.remove();
                    ToolContext.clearCurrentController();
                }
            });
        }
        return new DispatchResult(futures, controls, anySuppressed, hitlRef);
    }

    ToolCallValidator.Decision validateHITLToolCalls(ONode toolCalls) {
        if (toolCalls == null || !toolCalls.isArray()) {
            return ToolCallValidator.Decision.deny("工具调用格式无效");
        }
        for (ONode node : toolCalls.getArray()) {
            ToolCall toolCall = getToolCall(node);
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

                    if (userAbortRequested) {
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
                            cutinEngine.intercept(
                                    InterceptPoint.ON_TOOL_TIMEOUT,
                                    "tool",
                                    cutinContext,
                                    new LoopraToolBatchEvent(
                                            toolName(tcArray.get(resultIndex)),
                                            timeoutSec,
                                            subAgentCall,
                                            0));
                        } else {
                            safeOutput("toolTimeout", () -> output.onLog(LogLevel.WARN,
                                    "[tool] " + timeoutLabel + "执行超时（" + timeoutSec
                                            + "s），已请求停止: " + toolName(tcArray.get(resultIndex))));
                        }
                        results.set(i, timeoutResult(tcArray.get(i), timeoutLabel, timeoutSec, controls[i]));
                    } catch (CancellationException e) {
                        if (userAbortRequested) {
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
            cutinEngine.intercept(
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
            safeOutput("selfCorrect", () -> output.onLog(LogLevel.WARN,
                    "[self-correct] 已达自愈尝试上限（" + maxSelfCorrectionAttempts() + "次），停止循环"));
            return -1;
        }

        final int currentAttempts = selfCorrectionAttempts;
        safeOutput("selfCorrect", () -> output.onLog(LogLevel.INFO,
                "[self-correct] 所有工具调用被 storm 抑制，第" + currentAttempts + "次自愈尝试"));
        ctx.addUser("[系统提示：你刚刚重复调用了相同的工具。请换一种方式完成任务，"
                + "或直接用文本回答。]");
        return selfCorrectionAttempts;
    }

    // ==================== 内部辅助 ====================

    /** 用户中断后：将模型流已产出的内容写入上下文并返回 */
    private String handleAbortAfterStream(StreamResult sr) {
        String abortMarker = "\n\n<<用户主动停止生成>>";
        if (sr.content() != null && !sr.content().isEmpty()) {
            String markedContent = sr.content() + abortMarker;
            ctx.addAssistant(markedContent, null, sr.reasoningContent(), sr.thinkingBlocks(), List.of());
            return markedContent;
        }
        if (sr.reasoningContent() != null && !sr.reasoningContent().isEmpty()) {
            String markedReasoning = sr.reasoningContent() + abortMarker;
            ctx.addAssistant(null, null, markedReasoning);
            return markedReasoning;
        }
        return "⏹️ 已停止生成";
    }

    private void logAbort() {
        safeOutput("abort", () -> output.onLog(LogLevel.INFO, "[abort] 用户请求中断，停止推理循环"));
    }


    public ToolCall getToolCall(ONode n1) {
        String callId = n1.get("id").getString();

        String index = n1.get("index").getString();

        ONode n1f = n1.get("function");
        String name = n1f.get("name").getString(); //可能是空的
        ONode n1fArgs = n1f.get("arguments");
        String argStr = n1fArgs.getString();

        if (n1fArgs.isString()) {
            //有可能是 json string（还可能只是流的中间消息）
            if (FormatUtil.hasNestedJsonBlock(argStr)) {
                JsonReader reader = new JsonReader(argStr, Options.of(Feature.Read_AutoRepair));
                n1fArgs = reader.readLast();

                if (n1fArgs == null) {
                    log.warn("Parse tool arguments failed: {}", argStr);
                }
            }
        }

        Map<String, Object> argMap = new HashMap<>();
        if (n1fArgs != null) {
            if (n1fArgs.isObject()) {
                argMap = n1fArgs.toBean(Map.class);
            }
        }

        return new ToolCall(index, callId, name, argStr, argMap);
    }
}
