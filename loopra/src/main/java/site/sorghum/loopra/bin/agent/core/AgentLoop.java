package site.sorghum.loopra.bin.agent.core;

import lombok.Getter;
import lombok.Setter;
import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.ONode;
import org.noear.solon.ai.chat.interceptor.ToolRequest;
import org.noear.solon.ai.chat.tool.FunctionTool;
import org.noear.solon.ai.chat.tool.ToolCall;
import site.sorghum.cutin.core.context.Budget;
import site.sorghum.cutin.core.context.DefaultLoopContext;
import site.sorghum.cutin.core.context.Usage;
import site.sorghum.cutin.core.loop.CancelReason;
import site.sorghum.cutin.core.loop.DefaultLoopEngine;
import site.sorghum.cutin.core.loop.InterceptPoint;
import site.sorghum.cutin.core.loop.InterceptionResult;
import site.sorghum.cutin.core.loop.LoopHandle;
import site.sorghum.cutin.core.loop.LoopProgram;
import site.sorghum.cutin.core.loop.LoopResult;
import site.sorghum.cutin.core.loop.NodeType;
import site.sorghum.cutin.core.loop.ReentryRequest;
import site.sorghum.cutin.core.loop.StepResult;
import site.sorghum.cutin.core.model.ModelCallRequest;
import site.sorghum.cutin.core.model.ModelRegistry;
import site.sorghum.cutin.core.model.ModelResponse;
import site.sorghum.cutin.core.model.StreamChunk;
import site.sorghum.cutin.core.plugin.PluginBeanManager;
import site.sorghum.cutin.core.state.LoopSnapshot;
import site.sorghum.loopra.bin.agent.context.ContextTokenEstimate;
import site.sorghum.loopra.bin.agent.context.ConversationContext;
import site.sorghum.loopra.bin.agent.context.MessageHealer;
import site.sorghum.loopra.bin.agent.environment.SessionEnvironment;
import site.sorghum.loopra.bin.agent.hitl.HitlManager;
import site.sorghum.loopra.bin.agent.listener.AgentLoopListener;
import site.sorghum.loopra.bin.agent.listener.NoOpAgentLoopListener;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.model.FileChange;
import site.sorghum.loopra.bin.agent.model.HitlState;
import site.sorghum.loopra.bin.agent.model.ImageToolResult;
import site.sorghum.loopra.bin.agent.model.PreparedMessages;
import site.sorghum.loopra.bin.agent.model.StreamResult;
import site.sorghum.loopra.bin.agent.model.ToolCallEntry;
import site.sorghum.loopra.bin.agent.model.ToolExecutionResult;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.bin.agent.output.ConsoleAgentOutput;
import site.sorghum.loopra.bin.agent.resilient.ReasonBreaker;
import site.sorghum.loopra.bin.agent.resilient.StormBreaker;
import site.sorghum.loopra.bin.agent.spi.AgentConfig;
import site.sorghum.loopra.bin.agent.spi.GoalGuard;
import site.sorghum.loopra.bin.agent.spi.SessionUsageSink;
import site.sorghum.loopra.bin.model.LoopraModelProvider;
import site.sorghum.loopra.bin.model.ModelApiError;
import site.sorghum.loopra.bin.model.UserMessageSanitizer;
import site.sorghum.loopra.bin.session.SessionFileChangeTracker;
import site.sorghum.loopra.bin.tool.ToolMetadata;
import site.sorghum.loopra.bin.tool.ToolRegistry;
import site.sorghum.loopra.integration.cutin.CutinFunctionToolBridge;
import site.sorghum.loopra.integration.cutin.CutinMessageBridge;
import site.sorghum.loopra.integration.cutin.plugin.LoopraPluginRuntime;
import site.sorghum.loopra.integration.cutin.plugin.compaction.LoopraCompactionPlugin;
import site.sorghum.loopra.integration.cutin.plugin.exit.LoopraExitPlugin;
import site.sorghum.loopra.integration.cutin.plugin.external.ExternalPluginStore;
import site.sorghum.loopra.integration.cutin.plugin.httplog.LoopraHttpLogPlugin;
import site.sorghum.loopra.integration.cutin.plugin.plan.LoopraPlanPlugin;
import site.sorghum.loopra.integration.cutin.plugin.policy.LoopraMessageHealingPlugin;
import site.sorghum.loopra.integration.cutin.plugin.policy.LoopraModelPolicyPlugin;
import site.sorghum.loopra.integration.cutin.plugin.policy.LoopraPolicyHost;
import site.sorghum.loopra.integration.cutin.plugin.policy.LoopraToolPolicyPlugin;
import site.sorghum.loopra.integration.cutin.plugin.preflight.LoopraHitlPlugin;
import site.sorghum.loopra.integration.cutin.plugin.preflight.LoopraMessageSanitizerPlugin;
import site.sorghum.loopra.integration.cutin.plugin.preflight.LoopraPreflight;
import site.sorghum.loopra.integration.cutin.plugin.preflight.LoopraUserMessagePlugin;
import site.sorghum.loopra.integration.cutin.plugin.prompt.LoopraPromptHost;
import site.sorghum.loopra.integration.cutin.plugin.prompt.LoopraPromptPlugin;
import site.sorghum.loopra.integration.cutin.plugin.prompt.PromptRegistry;
import site.sorghum.loopra.integration.cutin.plugin.rawlog.LoopraRawLogPlugin;
import site.sorghum.loopra.integration.cutin.plugin.reasoning.LoopraReasoningStartedHost;
import site.sorghum.loopra.integration.cutin.plugin.reasoning.LoopraReasoningStartedPlugin;
import site.sorghum.loopra.integration.cutin.plugin.recovery.LoopraErrorRecoveryPlugin;
import site.sorghum.loopra.integration.cutin.plugin.retry.LoopraRetryHost;
import site.sorghum.loopra.integration.cutin.plugin.retry.LoopraRetryPolicyPlugin;
import site.sorghum.loopra.integration.cutin.plugin.session.LoopraSessionAffinityHost;
import site.sorghum.loopra.integration.cutin.plugin.session.LoopraSessionAffinityPlugin;
import site.sorghum.loopra.integration.cutin.plugin.session.LoopraSessionHost;
import site.sorghum.loopra.integration.cutin.plugin.session.LoopraSessionPlugin;
import site.sorghum.loopra.integration.cutin.plugin.tool.LoopraToolGatewayPlugin;
import site.sorghum.loopra.integration.cutin.plugin.toolbatch.LoopraToolBatchEvent;
import site.sorghum.loopra.integration.cutin.plugin.toolbatch.LoopraToolBatchHost;
import site.sorghum.loopra.integration.cutin.plugin.toolbatch.LoopraToolBatchPlugin;
import site.sorghum.loopra.integration.cutin.plugin.usage.LoopraTokenSpeedPlugin;
import site.sorghum.loopra.integration.cutin.plugin.usage.LoopraUsagePlugin;
import site.sorghum.loopra.integration.extpack.LoopraExtPackRuntime;
import site.sorghum.loopra.tool.AgentLoopController;
import site.sorghum.loopra.tool.AgentOutput;
import site.sorghum.loopra.tool.HitlRequiredException;
import site.sorghum.loopra.tool.LogLevel;
import site.sorghum.loopra.tool.ToolContext;
import site.sorghum.loopra.tool.ToolResult;
import site.sorghum.loopra.tool.interact.FinishTool;

import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
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
        LoopraSessionAffinityHost,
        LoopraRetryHost,
        LoopraSessionHost,
        LoopraToolBatchHost,
        LoopraReasoningStartedHost,
        LoopraPromptHost,
        LoopraToolGatewayPlugin.LoopraToolHost {

    // ==================== 配置读取（带 null-safe 默认值） ====================

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
    /** 计划模式与待审查计划，委托给 {@link PlanModeController}。 */
    private final PlanModeController planModeController = new PlanModeController(this);
    /** cutin 用量上报与 token 速率推送，委托给 {@link UsageReporter}。 */
    private final UsageReporter usageReporter = new UsageReporter(this);
    /** 上下文压力与折叠，委托给 {@link ContextCompactor}。 */
    private final ContextCompactor contextCompactor = new ContextCompactor(this);
    /** HITL 拦截与挂起恢复，委托给 {@link HitlController}。 */
    private final HitlController hitlController = new HitlController(this);
    /** 回合退出决策与 Goal 守卫，委托给 {@link TurnExitController}。 */
    private final TurnExitController turnExitController = new TurnExitController(this);
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

    @Getter
    private volatile String sessionId;

    /** 设置当前会话 ID，并同步给模型 Provider 以支持会话级路由。 */
    public void setSessionId(String sessionId) {
        this.sessionId = sessionId;
        modelProvider.setSessionAffinity(sessionId);
    }

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
    private volatile LoopState runningCutinState;

    /**
     * 查询主循环是否正在执行。
     *
     * @return true 表示当前 Agent 正在处理一个回合
     */
    public boolean isRunning() {
        return running.get();
    }

    Path workingDirectory() {
        Path environmentRoot = registry.getEnvironment() == null
            ? null
            : registry.getEnvironment().executionRoot();
        Path root = environmentRoot != null ? environmentRoot : workspace;
        return root == null ? null : root.toAbsolutePath().normalize();
    }

    // ==================== 协作类访问口（包级私有，仅供同包协作者使用） ====================

    DefaultLoopEngine cutinEngine() {
        return cutinEngine;
    }

    LoopHandle activeCutinHandle() {
        return activeCutinHandle;
    }

    void activeCutinHandle(LoopHandle handle) {
        this.activeCutinHandle = handle;
    }

    AgentLoopListener listener() {
        return listener;
    }

    void lastPromptTokens(int value) {
        this.lastPromptTokens = value;
    }

    void lastContextEstimate(ContextTokenEstimate estimate) {
        this.lastContextEstimate = estimate;
    }

    ConversationContext ctx() {
        return ctx;
    }

    PluginBeanManager cutinPlugins() {
        return cutinPlugins;
    }

    PlanModeController planModeController() {
        return planModeController;
    }

    TurnExitController turnExitController() {
        return turnExitController;
    }

    HitlController hitlController() {
        return hitlController;
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
        hitlController.toolCallValidator(ToolCallValidator.fromConfig(config, executionRoot));
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
        if (planModeController.isPlanMode()) {
            if (!tail.isEmpty()) {
                tail.append("\n\n");
            }
            tail.append(PlanModeController.PLAN_MODE_INSTRUCTIONS);
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
        plugins.registerPlugin(new LoopraMessageSanitizerPlugin(hitlController));
        plugins.registerPlugin(new LoopraHitlPlugin(hitlController));
        plugins.registerPlugin(new LoopraUserMessagePlugin(hitlController));
        plugins.registerPlugin(new LoopraUsagePlugin(usageReporter));
        plugins.registerPlugin(new LoopraTokenSpeedPlugin(usageReporter));
        plugins.registerPlugin(new LoopraSessionAffinityPlugin(this));
        plugins.registerPlugin(new LoopraCompactionPlugin(contextCompactor));
        plugins.registerPlugin(new LoopraReasoningStartedPlugin(this));
        plugins.registerPlugin(new LoopraModelPolicyPlugin(this));
        plugins.registerPlugin(new LoopraMessageHealingPlugin());
        plugins.registerPlugin(new LoopraToolPolicyPlugin(this));
        plugins.registerPlugin(new LoopraExitPlugin(turnExitController));
        plugins.registerPlugin(new LoopraErrorRecoveryPlugin(contextCompactor));
        plugins.registerPlugin(new LoopraRetryPolicyPlugin(this));
        plugins.registerPlugin(new LoopraSessionPlugin(this));
        plugins.registerPlugin(new LoopraPlanPlugin(planModeController));
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
        hitlController.toolCallValidator(toolCallValidator);
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

    /** 手动触发上下文折叠（/compact 命令）；实际折叠逻辑在 {@link ContextCompactor}。 */
    public void compactNow() throws IOException {
        contextCompactor.compactNow();
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
        turnExitController.finish(content);
    }

    /** 设置 Goal 守卫实例；实际状态由 {@link TurnExitController} 持有。 */
    public void setGoalGuard(GoalGuard goalGuard) {
        turnExitController.setGoalGuard(goalGuard);
    }

    /** 开关 Goal 守卫（子代理关闭）；实际状态由 {@link TurnExitController} 持有。 */
    public void setGoalGuardEnabled(boolean enabled) {
        turnExitController.setGoalGuardEnabled(enabled);
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
    void safeOutput(String tag, Runnable action) {
        try {
            action.run();
        } catch (Exception e) {
            log.warn("[{}] output异常: {}", tag, e.getMessage());
        }
    }

    /** 安全调用 output 方法，异常记录 debug 日志（用于 SSE delta 回调，断开是预期行为） */
    void safeOutputDebug(String tag, Runnable action) {
        try {
            action.run();
        } catch (Exception e) {
            log.debug("[{}] output异常(SSE可能已断开): {}", tag, e.getMessage());
        }
    }

    /** 安全调用 listener 方法，异常记录 warn 日志 */
    void safeListener(String tag, Runnable action) {
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
        return contextCompactor.refreshTools();
    }

    /** 固定后续请求的 system 附加指令和工具定义；必须在首轮模型调用前执行。 */
    public void freezePromptPrefix() {
        contextCompactor.freezePromptPrefix();
    }

    // ==================== 计划模式（委托 PlanModeController） ====================

    @Override
    public boolean isPlanMode() {
        return planModeController.isPlanMode();
    }

    /** 切换计划模式（会话级状态，仅影响本循环）。 */
    public void setPlanMode(boolean enabled) {
        planModeController.setPlanMode(enabled);
    }

    /** 保存 submit_plan 提交的任务计划，并通过 plan_submitted 事件通知前端。 */
    @Override
    public void submitPlan(String planMarkdown) {
        planModeController.submitPlan(planMarkdown);
    }

    /** 获取待审查计划（不移除）。 */
    public String getPendingPlan() {
        return planModeController.getPendingPlan();
    }

    /** 静默恢复持久化的待审查计划，不触发事件或重复写盘。 */
    public void restorePendingPlan(String planMarkdown) {
        planModeController.restorePendingPlan(planMarkdown);
    }

    /** 清除待审查计划并同步持久化。 */
    public void clearPendingPlan() {
        planModeController.clearPendingPlan();
    }

    /** 取出并清空待审查计划（/execute 批准时调用）。 */
    public String consumePendingPlan() {
        return planModeController.consumePendingPlan();
    }

    /** 过滤为只读工具集合；实际过滤逻辑在 {@link PlanModeController}。 */
    private ONode filterReadOnlyTools(ONode tools) {
        return planModeController.filterReadOnlyTools(tools);
    }

    /**
     * 获取工具注册表实例。
     */
    /**
     * 从当前上下文重新计算 token 构成。
     * <p>供历史会话在未执行新一轮模型请求时按持久化消息生成预估。</p>
     */
    public ContextTokenEstimate estimateCurrentContext() {
        return contextCompactor.estimateCurrentContext();
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

    /**
     * cutin 路径下的用量上报入口，实际处理在 {@link UsageReporter}。
     */
    public void reportCutinUsage(Usage usage) {
        usageReporter.reportCutinUsage(usage);
    }

    @Override
    public String sessionAffinity() {
        return sessionId;
    }


    @Override
    public void injectReasonBreakReminder() {
        ctx.addUser("[ReasonBreaker] 检测到思考循环，已提前终止本轮推理。请停止当前思路，尝试不同的方法。");
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
    public String suspendSandboxHITLIfPending(DefaultLoopContext context) {
        return hitlController.suspendSandboxHITLIfPending(context);
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
     * cutin 扩展点使用的上下文折叠入口，实际逻辑在 {@link ContextCompactor}。
     */
    @Override
    public PreparedMessages prepareCutinMessages(DefaultLoopContext context, int step) {
        return contextCompactor.prepareCutinMessages(context, step);
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
        return hitlController.interceptHITLFromCutin(response);
    }

    /** 获取用于新模型工具调用 ID 分配的当前历史；兼容无上下文的轻量测试入口。 */
    List<ChatMessage> messagesForToolCallNormalization() {
        return ctx == null ? List.of() : ctx.buildMessages();
    }

    String currentGoalInstruction() {
        return turnExitController.currentGoalInstruction();
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
            return hitlController.finishCutinResult(state, cutinContext, handle, result);
        } finally {
            activeCutinHandle = null;
            runningCutinState = null;
        }
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
            snapshot = CutinStreamSupport.collect(chunks);
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

        ONode toolCalls = CutinStreamSupport.scavengeToolCalls(snapshot.toolCalls(), snapshot.reasoningContent(), snapshot.content());
        toolCalls = MessageHealer.normalizeIncomingToolCallIds(
                toolCalls, messagesForToolCallNormalization());
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
                if (turnExitController.goalGuardActive()) {
                    turnExitController.loadOpenGoal();
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
        // 防御 HITL re-entry / 重试等非标准入口：工具执行和 assistant 历史必须使用同一批
        // 归一化后的 ID，否则 provider 会把两个 assistant function_call 视为同一个调用。
        snapshot = snapshot.withToolCalls(
                MessageHealer.normalizeIncomingToolCallIds(
                        snapshot.toolCalls(), messagesForToolCallNormalization()));
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

        if (turnExitController.pendingFinishContent() != null) {
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
        ONode normalizedToolCalls = MessageHealer.normalizeIncomingToolCallIds(
                sandboxState.toolCalls(), messagesForToolCallNormalization());
        List<ToolCallEntry> tcList = CutinStreamSupport.parseToolCallsFromONode(normalizedToolCalls);
        ctx.addAssistant(sandboxState.content(), tcList, sandboxState.reasoningContent());
        reasonBreaker.reset();
        stormBreaker.reset();
        resetUserAbort();

        ToolExecutionResult ter = executeToolCalls(normalizedToolCalls, context);
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
        if (turnExitController.pendingFinishContent() != null) {
            context.putVariable("loopraExitReason", "finish");
            return StepResult.Exit.INSTANCE;
        }
        if ("self_correction".equals(String.valueOf(
                context.variables().get("loopraExitReason")))) {
            return StepResult.Exit.INSTANCE;
        }
        return new StepResult.Goto("model");
    }


    static final class LoopState {
        int step;
        int noToolCallStreak;
        int selfCorrectionAttempts;
        String result;
        IOException ioError;
    }

    static int effectivePromptTokens(int offlineEstimate, int lastPromptTokens) {
        return Math.max(offlineEstimate, lastPromptTokens);
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
                    ToolCall toolCall = CutinStreamSupport.getToolCall(tc);
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
                    if (fc != null && cutinContext == null && planModeController.isPlanMode() && !ToolMetadata.isReadOnly(fc)) {
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
        return hitlController.validateHITLToolCalls(toolCalls);
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

}
