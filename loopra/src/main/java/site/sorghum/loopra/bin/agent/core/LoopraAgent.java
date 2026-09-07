package site.sorghum.loopra.bin.agent.core;

import lombok.Getter;
import lombok.SneakyThrows;
import lombok.extern.slf4j.Slf4j;
import org.noear.dami2.Dami;
import org.noear.dami2.bus.EventListener;
import site.sorghum.loopra.bin.agent.context.ContextTokenEstimate;
import site.sorghum.loopra.bin.agent.context.ConversationContext;
import site.sorghum.loopra.bin.agent.environment.SessionEnvironment;
import site.sorghum.loopra.bin.agent.listener.AgentLoopListener;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.model.FileChange;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.bin.agent.prompt.DEFAULT_PROMPT;
import site.sorghum.loopra.bin.agent.spi.GoalGuard;
import site.sorghum.loopra.bin.agent.spi.ToolPolicyProvider;
import site.sorghum.loopra.bin.command.ChatCommand;
import site.sorghum.loopra.bin.command.ChatCommandContext;
import site.sorghum.loopra.bin.command.ChatCommandRegistry;
import site.sorghum.loopra.bin.command.MessageWrapper;
import site.sorghum.loopra.bin.config.ConfigChangedEvent;
import site.sorghum.loopra.bin.config.ConfigServiceToolPolicyProvider;
import site.sorghum.loopra.bin.config.LoopraConfig;
import site.sorghum.loopra.bin.goal.GoalGuardImpl;
import site.sorghum.loopra.bin.model.LoopraModelProvider;
import site.sorghum.loopra.bin.project.ProjectRegistry;
import site.sorghum.loopra.bin.session.SessionService;
import site.sorghum.loopra.bin.session.SessionStore;
import site.sorghum.loopra.bin.tool.ToolRegistry;
import site.sorghum.loopra.bin.tool.ToolSystemInitializer;
import site.sorghum.loopra.tool.AgentOutput;

import java.io.IOException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * Loopra 工厂——组装 LoopraModelProvider + ToolRegistry → AgentLoop。
 *
 * @author Sorghum
 */
@Slf4j
public class LoopraAgent {

    /**
     * 主循环
     */
    private final AgentLoop loop;
    /**
     * 对话上下文
      * -- 读取器 --
     *  获取会话上下文（用于外部截断历史等操作）。

     */
    @Getter
    private final ConversationContext ctx;

    /**
     * 命令注册表（用于 chat() 中自动路由 "/" 开头的命令）
     */
    private final ChatCommandRegistry commandRegistry;

    private SessionService sessionService;
    /**
     * 会话存储是否为 Agent 自建（未注入 sessionStore 时为 true）。
     * 仅自建存储在 {@link #dispose()} 时关闭，上层注入的共享存储由注入方管理生命周期。
     */
    private boolean ownsSessionStore;
    /**
      * 本会话的项目根、执行根与状态根。
     */
    @Getter
    private final SessionEnvironment environment;

    private ProjectRegistry projectRegistry;

    /**
     * 退出信号（命令返回 EXIT 时设置，主循环据此终止）
      * -- 读取器 --
     * 检查是否收到退出信号（命令返回 EXIT 后为 true）
     */
    @Getter
    private volatile boolean terminated = false;

    /**
     * 配置变更事件监听器（每个 Agent 自监听自更新，dispose 时注销）。
     */
    private EventListener<ConfigChangedEvent> configListener;

    private LoopraAgent(Builder b) {
        this.commandRegistry = b.commandRegistry;
        this.environment = b.environment != null ? b.environment : SessionEnvironment.local(null);

        final String systemPrompt = resolvePrompt(b);
        // 注入共享工具系统时直接复用，跳过完整的工具扫描与提示词构建
        final ToolSystemInitializer.ToolSystem initResult = b.toolSystem != null
                ? b.toolSystem
                : ToolSystemInitializer.initialize(
                        this.environment, b.disabledTools, systemPrompt);
        this.ctx = new ConversationContext(initResult.promptPrefix());
        LoopraConfig loopConfig = b.loopraConfig != null ? b.loopraConfig : LoopraConfig.getInstance();
        this.loop = initSessionAndLoop(b, b.modelProvider, initResult.toolRegistry(), loopConfig);
        //  —— 每个 Agent 自监听自更新（保存引用以便 dispose 时注销）
        this.configListener = event -> {
            ConfigChangedEvent e = event.getPayload();
            if (e == null) return;
            log.info("[bus] 收到配置变更事件: key={}, value={}", e.key(), e.value());
            try {
                switch (e.key()) {
                    // 模型和思考强度属于会话设置。全局配置变更只影响新会话，
                    // 不能广播覆盖已经打开的会话 Agent。
                    case "model", "reasoningEffort" -> {
                        // 会话级变更由 AgentService 按会话显式应用。
                    }
                    case "fastMode" -> setFastMode(Boolean.parseBoolean(String.valueOf(e.value())));
                    case "hitl" -> setHitlMode(String.valueOf(e.value()));
                    case "terminateOnNoToolCall" -> setTerminateOnNoToolCall(Boolean.parseBoolean(String.valueOf(e.value())));
                    case "disabledTools", "toolReadOnlyOverrides" -> refreshTools();
                    default -> log.warn("[bus] 未知配置键: {}", e.key());
                }
            } catch (Exception ex) {
                log.error("[bus] 处理配置变更事件失败: key={}, value={}", e.key(), e.value(), ex);
            }
        };
        Dami.bus().listen("config.changed", this.configListener);
    }

    /**
     * 解析系统提示词：优先使用显式设置的 systemPrompt，否则回退到硬编码默认值。
     */
    private static String resolvePrompt(Builder b) {
        if (b.systemPrompt != null) return b.systemPrompt;
        return Builder.DEFAULT_SYSTEM_PROMPT;
    }

    /**
     * 初始化会话持久化和 Agent 推理循环（两个构造函数共享的逻辑）。
     * <p>
     * 完成 ProjectRegistry 初始化、SessionService 创建、
     * 历史会话加载以及 AgentLoop 的构造与 SessionService 绑定。
     * </p>
     *
     * @param b        Builder（携带上层可选注入的 goalGuard / toolPolicyProvider / sessionStore）
     * @param modelProvider 模型 Provider（LoopraModelProvider 或共享实例）
     * @param registry 工具注册表
     * @return 构造完成的 AgentLoop 实例
     */
    private AgentLoop initSessionAndLoop(Builder b, LoopraModelProvider modelProvider, ToolRegistry registry,
                                          LoopraConfig config) {
        try {
            final String workspacePath = environment.executionRoot() != null
                    ? environment.executionRoot().toAbsolutePath().toString()
                    : Paths.get(System.getProperty("user.home"), ".loopra").toString();
            // 状态根：会话持久化/Goal/Checklist 归属（隔离分支模式下为主项目）
            final String stateWorkspacePath = environment.stateRoot() != null
                    ? environment.stateRoot().toAbsolutePath().toString()
                    : workspacePath;
            this.projectRegistry = ProjectRegistry.getOrCreate(stateWorkspacePath);
            final Path sessionsDir = projectRegistry.getSessionsDir(stateWorkspacePath);
            this.ownsSessionStore = b.sessionStore == null;
            this.sessionService = (b.sessionStore != null)
                    ? new SessionService(ctx, b.sessionStore)
                    : new SessionService(ctx, sessionsDir);
            sessionService.loadOrCreate(System.getenv("LOOPRA_SESSION"));
        } catch (IOException e) {
            log.error("[session] 初始化失败: {}", e.getMessage(), e);
            throw new RuntimeException("[session] Loopra 会话初始化失败，无法继续运行", e);
        }

        final AgentLoop agentLoop = new AgentLoop(modelProvider, registry, ctx, config);
        agentLoop.setHitlMode(b.hitl);
        agentLoop.setWorkspace(environment.executionRoot());
        agentLoop.setSessionUsageSink(this.sessionService);
        agentLoop.setGoalGuard(b.goalGuard != null ? b.goalGuard : new GoalGuardImpl());
        restorePlanState(agentLoop, ctx.getSessionStore().currentName());
        registry.setToolPolicyProvider(b.toolPolicyProvider != null ? b.toolPolicyProvider : new ConfigServiceToolPolicyProvider());
        return agentLoop;
    }

    // 使用 ToolDefHelper 提供的公共方法


    // ========== 公共 API ==========

    public static Builder builder() {
        return new Builder();
    }

    /**
     * 处理用户输入，自动路由 "/" 命令或转发到 LLM 推理循环。
     * <p>
     * 命令处理通过 {@link ChatCommandRegistry} 自动分发 ——
     * 新增命令只需实现 {@link ChatCommand} 接口并标注 {@code @Component}，
     * 即可被 IoC 容器收集并在此处自动匹配执行。
     * </p>
     * <p>
     * {@link UserMessage} 支持纯文本和多模态（文本+图片）输入。
     * 传递 {@code null} 用于 HITL 恢复。
     * </p>
     */
    @SneakyThrows
    public String chat(UserMessage userMessage) {
        // HITL 恢复（approve/deny 后传入 null 触发恢复）
        if (userMessage == null) {
            return loop.run(null);
        }

        // 尝试命令路由
        CommandHandleResult cmdResult = tryHandleCommand(userMessage);
        if (cmdResult != null) {
            if (cmdResult.result() != null) {
                return cmdResult.result();
            }
            // 命令修改了消息内容，继续用修改后的消息走聊天流程
            if (cmdResult.modifiedMessage() != null) {
                userMessage = cmdResult.modifiedMessage();
            }
        }

        // 普通聊天逻辑
        String currentSessionId = sessionService != null ? sessionService.getStore().currentName() : null;
        loop.setSessionId(currentSessionId);
        return loop.run(userMessage);
    }

    /** 命令处理结果：result 为返回给用户的字符串（null=继续聊天），modifiedMessage 为命令修改后的消息 */
    private record CommandHandleResult(String result, UserMessage modifiedMessage) {}

    /**
     * 尝试将输入路由到斜杠命令。
     *
     * @return 命令处理结果；若未匹配到命令返回 {@code null}
     */
    @SneakyThrows
    private CommandHandleResult tryHandleCommand(UserMessage userMessage) {
        String text = userMessage.getText();
        if (text == null || !text.startsWith("/") || commandRegistry == null) {
            return null;
        }

        ChatCommand cmd = commandRegistry.match(text);
        if (cmd == null) {
            return null; // "/" 开头但不是已知命令，降级为普通聊天消息
        }
        if ("goal".equals(cmd.getCommand())) {
            sessionService.ensureSessionName();
            loop.setSessionId(sessionService.getStore().currentName());
        }

        MessageWrapper wrapper = MessageWrapper.builder().message(text).build();
        ChatCommandContext cmdContext = new ChatCommandContext(
                this, null, () -> this.terminated = true);
        ChatCommand.CommandResult result = cmd.execute(wrapper, cmdContext);

        // 命令可能修改了文本内容
        String newText = wrapper.getMessage();
        UserMessage updated = UserMessage.of(newText, userMessage.getImages());

        flushSession();
        saveUsage();

        if (result == ChatCommand.CommandResult.EXIT) {
            this.terminated = true;
            return new CommandHandleResult("/exit", null);
        }
        if (cmd.isSilent()) {
            return new CommandHandleResult(null, null); // 静默命令不返回确认消息
        }
        if (result != ChatCommand.CommandResult.LOOP) {
            return new CommandHandleResult("✅ 已执行 " + newText + " 命令", null);
        }
        // LOOP: 命令已修改消息，继续走正常聊天流程
        return new CommandHandleResult(null, updated);
    }

    /**
     * 切换到指定会话。
     * 切换后加载历史消息到上下文并恢复 token 用量。
     */
    public void bindSession(String name) {
        boolean ok = ctx.getSessionStore().bindTo(name);
        if (ok) {
            // 加载会话历史消息到上下文，将 JSONL 中的 OpenAI 格式 tool_calls
            // 转回内存格式 {id, name, arguments}，与新创建的消息保持一致
            try {
                List<ChatMessage> loaded = ctx.getSessionStore().load();
                for (ChatMessage m : loaded) {
                    ctx.injectHistory(m);
                }
            } catch (IOException e) {
                log.error("[session] 加载会话历史失败: {}", e.getMessage());
            }
            // 恢复该会话的 token 用量
            sessionService.restoreUsage(name);
            String existingTitle = ctx.getSessionStore().getTitle(name);
            sessionService.setTitleGenerated(existingTitle != null && !existingTitle.isEmpty());
            // 恢复持久化的计划模式与待审查计划（静默恢复，不发事件；
            // Agent 重建/会话切换后不丢失只读约束和待批准计划）
            restorePlanState(loop, name);
        }
    }

    private void restorePlanState(AgentLoop targetLoop, String name) {
        if (targetLoop == null || name == null) return;
        try {
            targetLoop.setPlanMode(ctx.getSessionStore().isPlanMode(name));
            targetLoop.restorePendingPlan(ctx.getSessionStore().getPendingPlan(name));
        } catch (Exception e) {
            log.warn("[plan] 恢复计划状态失败: {}", e.getMessage());
        }
    }

    /** 累计 token 用量 */
    public void addUsage(int prompt, int completion, int cacheHit, int cacheMiss) {
        sessionService.addUsage(prompt, completion, cacheHit, cacheMiss);
    }

    /**
     * 按模型累计 token 用量
     */
    public void addUsage(String model, int prompt, int completion, int cacheHit, int cacheMiss) {
        sessionService.addUsage(model, prompt, completion, cacheHit, cacheMiss);
    }

    /**
     * 获取会话累计 token 用量
     */
    public long[] getSessionUsage() {
        return sessionService.getUsage();
    }

    /**
     * 获取按模型分别累计的 token 用量
     */
    public Map<String, long[]> getModelUsage() {
        return sessionService.getModelUsage();
    }

    /**
     * 标记会话标题已生成（用户手动重命名后调用），
     * 避免后续回合开始时用首条消息自动覆盖用户自定义的名称。
     */
    public void markSessionTitleGenerated() {
        sessionService.setTitleGenerated(true);
    }

    /**
     * 查询当前 Agent 是否正在执行推理回合。
     *
     * @return true 表示主循环正在运行
     */
    public boolean isRunning() {
        return loop != null && loop.isRunning();
    }

    /** getMaxContextTokens 回退默认值（模型客户端不可用时的保守值） */
    private static final int DEFAULT_FALLBACK_MAX_TOKENS = 128000;

    /**
     * 获取模型最大上下文窗口 token 数
     */
    public int getMaxContextTokens() {
        return loop != null ? loop.getMaxContextTokens() : DEFAULT_FALLBACK_MAX_TOKENS;
    }

    /** 获取最近一次请求的离线上下文构成。 */
    public ContextTokenEstimate getLastContextEstimate() {
        return loop != null ? loop.getLastContextEstimate() : null;
    }

    /** 根据已加载的会话历史重算离线上下文构成。 */
    public ContextTokenEstimate estimateCurrentContext() {
        return loop != null ? loop.estimateCurrentContext() : null;
    }

    /**
     * /retry 撤回最后一条消息并重试
     */
    public String retryLast() {
        String msg = ctx.retryLastUser();
        return msg != null ? chat(UserMessage.of(msg)) : null;
    }

    /**
     * /rewind N 回退到第 N 轮
     */
    public String rewind(int n) {
        String msg = ctx.rewindToUser(n);
        return msg != null ? chat(UserMessage.of(msg)) : null;
    }

    public void setListener(AgentLoopListener listener) {
        loop.setListener(listener);
    }

    /**
     * 获取当前输出接口
     */
    public AgentOutput getOutput() {
        return loop.getOutput();
    }

    /**
     * 设置输出接口。
     * <p>
     * 所有 Agent 的输出（流式内容、思考、工具调用、日志等）都会通过此接口发送。
     * 可传入自定义实现（如 WebSocket SSE、日志文件等）。
     * </p>
     *
     * @param output 输出接口实现，传入 null 则使用 NOOP（关闭输出）
     */
    public void setOutput(AgentOutput output) {
        loop.setOutput(output);
    }

    /**
     * 设置当前会话ID（用于工具执行上下文）
     */
    public void setSessionId(String sessionId) {
        if (loop != null) {
            loop.setSessionId(sessionId);
        }
    }

     /** 返回当前用户回合产生的全部已持久化文件变更列表。 */
    public List<List<FileChange>> getCurrentTurnFileChanges() {
        List<List<FileChange>> result = new java.util.ArrayList<>();
        List<ChatMessage> history = ctx.getHistory();
        for (int i = history.size() - 1; i >= 0; i--) {
            ChatMessage message = history.get(i);
            if (message.isUser()) break;
            if (message.isAssistant() && message.getFileChanges() != null && !message.getFileChanges().isEmpty()) {
                result.add(0, List.copyOf(message.getFileChanges()));
            }
        }
        return result;
    }

     // ========== HITL（人在回路）==========

    /**
     * 获取当前 HITL 模式名称。
     *
      * @return HITL 模式："free"（自由）/ "approval"（审批）/ "auto"（自动）
     */
    public String getHitlMode() {
        return loop.getHitlMode();
    }

    /**
     * 直接设置 HITL 模式（用于配置热更新）
     *
     * @param mode "free" / "approval" / "auto"，向后兼容 "true"/"false"
     */
    public void setHitlMode(String mode) {
        loop.setHitlMode(mode);
    }

    /**
     * 运行时切换模型（热更新）。
     * 每个 Agent 持有自己的 LoopraModelProvider，互不影响。
     */
    public void setModel(String model) {
        loop.setModel(model);
    }

    /** 获取当前会话使用的模型。 */
    public String getModel() {
        return loop.getModel();
    }

    /** 获取当前会话使用的模型渠道。 */
    public String getModelChannelId() {
        return loop.getModelChannelId();
    }

    /**
     * 运行时切换推理强度（热更新）。
     * 值由模型提供者定义，前端请求会将其传入对应会话。
     */
    public void setReasoningEffort(String reasoningEffort) {
        loop.setReasoningEffort(reasoningEffort);
    }

    /** 获取当前会话使用的思考强度。 */
    public String getReasoningEffort() {
        return loop.getReasoningEffort();
    }

    /** 根据当前会话选中的模型切换最大输出 token 数。 */
    public void setMaxTokens(int maxTokens) {
        loop.setMaxTokens(maxTokens);
    }

    /** 运行时切换快速模式（热更新，OpenAI service_tier=fast，仅 OpenAI 协议生效）。 */
    public void setFastMode(boolean fastMode) {
        loop.setFastMode(fastMode);
    }

    /** 运行时更新无工具调用时的结束策略。 */
    public void setTerminateOnNoToolCall(boolean enabled) {
        loop.setTerminateOnNoToolCall(enabled);
    }

    // ========== 计划模式（Plan Mode） ==========

    /**
     * 切换计划模式：更新循环状态 + 持久化到会话元数据 + 通知前端。
     * <p>幂等：重复设置相同状态时不做任何操作。</p>
     *
     * @param enabled true 进入（仅只读），false 退出（恢复全部工具）
     */
    public void setPlanMode(boolean enabled) {
        if (loop == null || loop.isPlanMode() == enabled) {
            return;
        }
        loop.setPlanMode(enabled);
        // 持久化：Agent 被 LRU 淘汰重建后能恢复，避免静默放宽为可写
        try {
            if (sessionService != null) {
                sessionService.ensureSessionName();
                String name = ctx.getSessionStore().currentName();
                if (name != null) {
                    ctx.getSessionStore().setPlanMode(name, enabled);
                }
            }
        } catch (Exception e) {
            log.warn("[plan] 持久化计划模式失败: {}", e.getMessage());
        }
        AgentOutput out = loop.getOutput();
        if (out != null) {
            out.sendEvent("mode_changed",
                    "{\"mode\":\"" + (enabled ? "plan" : "execute") + "\"}");
        }
        log.info("[plan] 计划模式已{}", enabled ? "开启" : "关闭");
    }

    /** 当前是否处于计划模式。 */
    public boolean isPlanMode() {
        return loop != null && loop.isPlanMode();
    }

    /** 取出并清空 submit_plan 提交的待审查计划（/execute 批准时调用）。 */
    public String consumePendingPlan() {
        return loop != null ? loop.consumePendingPlan() : null;
    }

    /** 获取待审查计划（不移除）。 */
    public String getPendingPlan() {
        return loop != null ? loop.getPendingPlan() : null;
    }

    /**
     * 为 Web 批准流程准备执行指令。待审查计划在模型真正启动前不会被消费，
     * 以便请求失败时恢复审查状态。
     */
    public String preparePendingPlanExecution() {
        String plan = getPendingPlan();
        if (plan == null || plan.isBlank()) return null;
        setPlanMode(false);
        return buildPlanExecutionMessage(plan);
    }

    /** 模型执行尚未启动即失败，恢复计划模式并重新推送待审查计划。 */
    public void restorePendingPlanExecution() {
        String plan = getPendingPlan();
        if (plan == null || plan.isBlank()) return;
        setPlanMode(true);
        loop.submitPlan(plan);
    }

    public String approvePendingPlan() {
        String executionMessage = preparePendingPlanExecution();
        if (executionMessage != null) clearPendingPlan();
        return executionMessage;
    }

    private static String buildPlanExecutionMessage(String plan) {
        return """
                执行计划已批准，计划模式已退出（全部工具恢复可用）。请严格按以下计划逐步执行：

                %s

                现在开始执行：按步骤推进，每步完成后继续下一步；如遇与计划不符的情况，先说明差异再妥善处理。
                """.formatted(plan.trim());
    }

    /** 清除待审查计划（撤回/重写历史时调用）。 */
    public void clearPendingPlan() {
        if (loop != null) loop.clearPendingPlan();
    }

    /**
     * 刷新工具列表（工具启用/禁用状态变更后调用）。
     */
    public void refreshTools() {
        loop.refreshTools();
        log.info("[agent] 工具列表已刷新");
    }

    /**
     * 切换 HITL 模式
     */
    public void toggleHitl() {
        loop.toggleHitl();
    }

    /**
     * 批准待执行的工具调用
     */
    public void approveHITL() {
        loop.approveHITL();
    }

    /**
     * 拒绝待执行的工具调用
     */
    public void denyHITL() {
        loop.denyHITL();
    }

    /**
     * 是否有待审批的工具调用
     */
    public boolean noPendingHITL() {
        return !loop.hasPendingHITL();
    }

    /**
     * 保存会话用量（退出前调用）
     */
    public void saveUsage() {
        sessionService.saveUsage();
    }

    /**
     * 中断当前聊天 —— 调用底层 LoopraModelProvider 的中断方法。
     * 用于前端主动停止生成。
     */
    public void abort() {
        if (loop != null) {
            loop.requestUserAbort();
        }
    }

    public boolean isAbortRequested() {
        return loop != null && loop.isAbortRequested();
    }

    /**
     * 刷入会话数据到磁盘。
     * 每轮对话结束后调用，确保消息已持久化。
     */
    public void flushSession() {
        sessionService.flush();
    }

    /**
     * 释放 Agent 资源：注销事件监听、刷入会话、保存用量、关闭自建会话存储。
     * 当 Agent 被 LRU 淘汰或应用关闭时调用，防止内存泄漏。
     * <p>仅关闭自建的 SessionStore；上层注入的共享存储由注入方管理生命周期。</p>
     */
    public void dispose() {
        // 主循环仍在运行时先请求中断，避免 dispose 后推理循环继续执行工具（停止请求将无法再命中它）
        if (loop != null && loop.isRunning()) {
            log.info("[dispose] Agent 主循环仍在运行，先请求中断");
            loop.requestUserAbort();
        }
        // 注销 Dami 事件监听
        if (configListener != null) {
            try {
                Dami.bus().unlisten("config.changed", configListener);
                configListener = null;
            } catch (Exception e) {
                log.warn("[dispose] 注销配置变更监听失败: {}", e.getMessage());
            }
        }
        // 刷入会话和用量
        try {
            flushSession();
            saveUsage();
        } catch (Exception e) {
            log.warn("[dispose] 刷入会话失败: {}", e.getMessage());
        }
        // 关闭自建会话存储（释放消费者线程 + 定时刷入 scheduler + writer）
        if (ownsSessionStore && sessionService != null) {
            try {
                sessionService.getStore().shutdown();
            } catch (Exception e) {
                log.warn("[dispose] 关闭会话存储失败: {}", e.getMessage());
            }
        }
        loop.disposeCutinPlugins();
    }

    public void compact() throws IOException {
        sessionService.saveUsage();
        loop.compactNow();
    }

    // ---- 项目文档加载 ----

    public int historySize() {
        return ctx.size();
    }

    public static class Builder {
        /**
         * 硬编码的默认系统提示词（作为 system prompt 基底，不再从文件加载）
         */
        public static final String DEFAULT_SYSTEM_PROMPT = DEFAULT_PROMPT.PROMPT;
        /**
         * 系统提示词，默认使用硬编码的 DEFAULT_SYSTEM_PROMPT。
         */
        String systemPrompt = DEFAULT_SYSTEM_PROMPT;
        /** 显式会话环境。 */
        SessionEnvironment environment;
        Set<String> disabledTools;
        String hitl = "free";
        /**
         * 命令注册表（Solon 自动收集的 ChatCommand Bean）
         */
        ChatCommandRegistry commandRegistry;
        /**
         * LoopraModelProvider（用于轻量级构建，避免重复创建 HTTP Provider）
         */
        LoopraModelProvider modelProvider;
        /**
         * 共享配置
         */
        LoopraConfig loopraConfig;
        /**
         * Goal 守卫（可选，默认 {@link GoalGuardImpl}）。
         * <p>上层（如 loopra-web）可注入自定义实现以定制 Goal 生命周期管理。</p>
         */
        GoalGuard goalGuard;
        /**
         * 工具策略提供者（可选，默认 {@link ConfigServiceToolPolicyProvider}）。
         * <p>上层可注入自定义实现以定制工具启用/禁用与只读策略。</p>
         */
        ToolPolicyProvider toolPolicyProvider;
        /**
         * 会话存储（可选，默认基于项目会话目录的 {@code JsonlSessionStore}）。
         * <p>上层可注入自定义 {@link SessionStore} 以定制会话持久化。</p>
         */
        SessionStore sessionStore;
        /**
         * 共享工具系统初始化结果（可选，含 ToolRegistry + PromptPrefix + 系统提示词）。
         * <p>注入后跳过 {@link ToolSystemInitializer#initialize}，复用共享的工具注册表
         * 与预构建的提示词前缀，避免每个 Agent 重复扫描工具。Result 内的环境必须
         * 与 Builder 配置的 {@link SessionEnvironment} 一致。</p>
         */
        ToolSystemInitializer.ToolSystem toolSystem;

        public Builder systemPrompt(String v) {
            this.systemPrompt = v;
            return this;
        }

        public Builder environment(SessionEnvironment v) {
            this.environment = v;
            return this;
        }

        public Builder commandRegistry(ChatCommandRegistry v) {
            this.commandRegistry = v;
            return this;
        }

        public Builder hitl(String v) {
            this.hitl = v;
            return this;
        }

        public Builder config(LoopraConfig c) {
            this.loopraConfig = c;
            if (c.workspaceDir() != null) {
                this.environment = SessionEnvironment.local(c.workspaceDir());
            }
            this.disabledTools = c.disabledTools();
            this.hitl = c.hitl();
            return this;
        }

        /**
         * 单独设置共享的 LoopraModelProvider
         */
        public Builder modelProvider(LoopraModelProvider v) {
            this.modelProvider = v;
            return this;
        }

        /**
         * 注入自定义 Goal 守卫；不设置则使用默认 {@link GoalGuardImpl}。
         */
        public Builder goalGuard(GoalGuard v) {
            this.goalGuard = v;
            return this;
        }

        /**
         * 注入自定义工具策略提供者；不设置则使用默认 {@link ConfigServiceToolPolicyProvider}。
         */
        public Builder toolPolicyProvider(ToolPolicyProvider v) {
            this.toolPolicyProvider = v;
            return this;
        }

        /**
         * 注入自定义会话存储；不设置则使用默认的 JSONL 文件存储。
         * <p>注入的存储由调用方管理生命周期，{@code dispose()} 不会关闭它。</p>
         */
        public Builder sessionStore(SessionStore v) {
            this.sessionStore = v;
            return this;
        }

        /**
         * 注入共享的工具系统初始化结果；设置后跳过内部工具系统初始化，直接复用。
         * <p>用于多 Agent 共享同一项目的工具注册表与提示词前缀，避免重复初始化。</p>
         */
        public Builder toolSystem(ToolSystemInitializer.ToolSystem v) {
            this.toolSystem = v;
            return this;
        }



        /**
         * 构建轻量级 Agent 实例。
         * <p>共享 LoopraModelProvider，工具系统默认每次构建独立初始化；
         * 注入 {@code toolSystem} 时复用共享初始化结果，跳过重复扫描。
         * 仅创建独立的会话上下文。适用于"一个会话一个 Agent"场景，减少资源消耗。</p>
         *
         * @return 轻量级 Agent 实例
         */
        public LoopraAgent buildLightweight() {
            Objects.requireNonNull(modelProvider, "sharedModelProvider is required");
            return new LoopraAgent(this);
        }
    }
}
