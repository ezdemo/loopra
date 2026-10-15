package site.sorghum.loopra.bin.agent.core;

import lombok.extern.slf4j.Slf4j;
import site.sorghum.loopra.bin.agent.context.ConversationContext;
import site.sorghum.loopra.bin.agent.hitl.SubAgentHITLBroker;
import site.sorghum.loopra.bin.agent.listener.AgentLoopListener;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.bin.agent.output.SubAgentAgentOutput;
import site.sorghum.loopra.bin.agent.output.SubAgentEventRecorder;
import site.sorghum.loopra.bin.agent.prompt.PromptPrefix;
import site.sorghum.loopra.bin.agent.spi.AgentConfig;
import site.sorghum.loopra.bin.agent.spi.SessionUsageSink;
import site.sorghum.loopra.bin.model.LoopraModelProvider;
import site.sorghum.loopra.bin.tool.ToolRegistry;
import site.sorghum.loopra.tool.AgentLoopController;
import site.sorghum.loopra.tool.AgentOutput;

import java.io.IOException;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 子代理 —— 隔离的子 AgentLoop，继承父工具集。
 * <p>
 * 参考 Loopra TS 的 subagent.ts：
 * 创建一个独立的子循环，继承父级的 ToolRegistry 但排除某些工具，
 * 执行完返回最终结果。
 * </p>
 *
 * @author Sorghum
 */
@Slf4j
public class SubAgent {

    /**
     * 子代理禁止使用的工具名集合（全局维护，新增工具自动对子代理可用）。
     * <p>排除：递归 spawn、工作流管理、会话任务跟踪、用户交互。</p>
     * <ul>
     *   <li><b>sub_agent</b> — 防止递归子代理 spawn</li>
     *   <li>checklist_start / checklist_step / checklist_status — 清单管理，主代理专用</li>
     *   <li>goal_* — 目标跟踪，主代理专用</li>
     *   <li>ask_choice — 用户交互，主代理专用（子代理无用户交互）</li>
     * </ul>
     * <p>public 可见性供 {@code SubAgentTool} 构建子代理 system prompt 时保持一致的过滤逻辑。</p>
     */
    public static final Set<String> SUB_AGENT_DENY = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
            "sub_agent",           // 防止递归子代理 spawn
            "checklist_start",      // 清单创建（主代理专用）
            "checklist_step",       // 清单转步（主代理专用）
            "checklist_status",     // 清单状态（主代理专用）
            "goal_create",         // Goal 状态机（主代理专用）
            "goal_status",
            "goal_update_step",
            "goal_complete",
            "goal_block",
            "goal_resume",
            "ask_choice",          // 用户交互（主代理专用）
            "browser_request_user_action", // 浏览器人工接管（主代理专用）
            "submit_plan"          // 计划提交（主代理专用，计划模式产物由主代理负责）
    )));

    private final LoopraModelProvider modelProvider;
    private final ToolRegistry registry;
    private final String systemPrompt;
    /**
     * 父级 AgentLoopController —— 用于传播父级的中断信号到子代理。
     * 子代理的主循环会同时检查自身中断标志和父级的 isAbortRequested()。
     */
    private final AgentLoopController parentController;
    /** 每个子代理实例独有，用于构造不与其他子代理冲突的缓存会话标识。 */
    private final String cacheSessionNonce = UUID.randomUUID().toString();
    /** 父代理输出通道，子代理用它把流式结果实时推送给用户。 */
    private AgentOutput parentOutput = null;
    /** 本轮执行的事件输出目标；非 null 时优先于父输出（继续对话时替换为新的 SSE 通道） */
    private volatile AgentOutput outputTarget = null;
    /** 父会话 ID（用于子代理 tools 中的 sessionId 传递） */
    private String sessionId = null;
    /** 父会话用量上报通道（用于子代理 token 用量直接上报） */
    private SessionUsageSink sessionUsageSink = null;
    /** 代理配置（继承父级，确保上下文折叠/工具超时等行为一致） */
    private AgentConfig config = null;
    /** 子代理 HITL 模式。默认 "free"，由父代理精确继承 free/approval/auto。 */
    private String hitlMode = "free";
    /** 子代理的 AgentLoop 引用（用于 HITL 暂停-恢复） */
    private volatile AgentLoop subLoop = null;
    /** 在子循环创建前收到的取消信号。 */
    private final AtomicBoolean abortRequested = new AtomicBoolean(false);
    /** 子代理唯一标识（由 SubAgentAgentOutput 分配，用于 HITL Broker 注册） */
    private int subAgentId = 0;
    /** 子代理会话记录器（可选）：把执行过程以段级粒度落盘为子代理会话，挂在父会话下 */
    private SubAgentEventRecorder recorder = null;
    /** 子代理会话名称（name + 首句话，由 SubAgentTool 注入）：sub_start 事件与回放列表均以此命名，多轮不变 */
    private String sessionName = null;
    /** 子代理名字（人名/二次元名字等，由 SubAgentTool 注入） */
    private String agentName = null;
    /** 会话标题（任务首句，由 SubAgentTool 注入） */
    private String sessionTitle = null;

    /**
     * 构造函数（接受 LoopraModelProvider，便于 DI）
     *
     * @param modelProvider     模型 Provider（子代理应使用 fork 后的独立实例）
     * @param parentRegistry    父级工具注册表（复制并过滤后用于子代理）
     * @param systemPrompt      子代理的系统提示词
     * @param parentController  父级 AgentLoopController（可 null，用于传播中断信号）
     */
    public SubAgent(LoopraModelProvider modelProvider, ToolRegistry parentRegistry, String systemPrompt,
                    AgentLoopController parentController) {
        this.modelProvider = Objects.requireNonNull(modelProvider, "modelProvider must not be null");
        this.modelProvider.setSessionAffinity("sub-agent:" + cacheSessionNonce);
        // 创建独立注册表，通过 forceDenyTools 硬性过滤（禁止递归 spawn 等）
        this.registry = Objects.requireNonNull(parentRegistry, "parentRegistry must not be null").copy();
        this.registry.setForceDenyTools(SUB_AGENT_DENY);
        this.systemPrompt = systemPrompt;
        this.parentController = parentController;
        if (parentController != null) {
            this.parentOutput = parentController.getOutput();
            this.sessionUsageSink = parentController.getSessionUsageSink();
            this.config = parentController.getAgentConfig();
            this.hitlMode = parentController.getHitlMode();
        }
    }

    /**
     * 构造函数（无父级 controller，用于测试或独立场景）
     */
    public SubAgent(LoopraModelProvider modelProvider, ToolRegistry parentRegistry, String systemPrompt) {
        this(modelProvider, parentRegistry, systemPrompt, null);
    }

    /**
     * 设置父会话 ID，用于子代理 tools 中的 sessionId 传递。
     */
    public void setSessionId(String sessionId) {
        this.sessionId = sessionId;
        if (sessionId != null && !sessionId.isBlank()) {
            modelProvider.setSessionAffinity(sessionId + ":sub-agent:" + cacheSessionNonce);
        }
    }

    /**
     * 设置代理配置，继承父级以确保上下文折叠/工具超时等行为一致。
     */
    public void setConfig(AgentConfig config) {
        this.config = config;
    }

    /** 设置角色级工具白名单；传 null 表示继承父代理的全部可用工具。 */
    public void setAllowedTools(Set<String> allowedTools) {
        this.registry.setForceAllowTools(allowedTools);
    }

    /**
     * 获取子代理 HITL 模式。
     */
    public String getHitlMode() {
        return hitlMode;
    }

    /**
     * 获取子代理唯一标识（由 SubAgentAgentOutput 创建时分配）。
     */
    public int getSubAgentId() {
        return subAgentId;
    }

    /**
     * 显式停止子代理。可在子循环创建前调用，创建后会中止模型流和活动工具。
     */
    public void abort() {
        abortRequested.set(true);
        AgentLoop loop = subLoop;
        if (loop != null) {
            loop.requestUserAbort();
        }
    }

    /**
     * 设置子代理会话记录器（可选）。设置后子代理执行过程会持久化为独立子代理会话。
     */
    public void setRecorder(SubAgentEventRecorder recorder) {
        this.recorder = recorder;
    }

    /**
     * 运行子代理，返回最终回复。
     * 子代理拥有独立的 ConversationContext 和 AgentLoop，
     * 继承父级工具集（排除递归 spawn 和用户交互工具）。
     * <p>
     * 支持多轮：首次调用创建子循环与上下文，后续调用（继续对话）复用同一循环累积消息；
     * 每轮都会挂载新一轮输出链，记录器以 sub_start/sub_end 对续写同一子代理会话。
     * </p>
     *
     * @param task     子代理的任务描述
     * @param listener 事件监听（可选）
     * @return 子代理的最终回复文本
     */
    public String run(String task, AgentLoopListener listener) throws IOException {
        if (abortRequested.get()) {
            return "⏹️ 子代理已取消";
        }
        SubAgentEventRecorder activeRecorder = this.recorder;
        String endStatus = "completed";
        try {
            return doRun(task, listener);
        } catch (IOException | RuntimeException e) {
            endStatus = "error";
            throw e;
        } finally {
            // 记录收尾：结束状态按 abort > 异常 > 正常 判定；未挂载（未真正执行）时为 no-op
            if (activeRecorder != null) {
                activeRecorder.end(abortRequested.get() ? "aborted" : endStatus);
            }
        }
    }

    /** 子代理是否已被显式取消（取消后不可再继续对话）。 */
    public boolean isAbortRequested() {
        return abortRequested.get();
    }

    /** 替换本轮执行的事件输出目标（继续对话时指向新的 SSE 通道，避免事件回流到已结束的父聊天流）。
     * 传 null 恢复为父输出。
     */
    public void setOutputTarget(AgentOutput output) {
        this.outputTarget = output;
    }

    /** 设置子代理会话名称（name + 首句话）：决定 sub_start 事件与回放列表的会话命名，多轮保持稳定。 */
    public void setSessionName(String sessionName) {
        this.sessionName = sessionName;
    }

    /** 设置子代理名字（人名/二次元名字等），随 sub_start 事件落盘供列表展示。 */
    public void setAgentName(String agentName) {
        this.agentName = agentName;
    }

    /** 设置会话标题（任务首句），随 sub_start 事件落盘供列表展示。 */
    public void setSessionTitle(String sessionTitle) {
        this.sessionTitle = sessionTitle;
    }

    /**
     * 首次执行时创建子循环与上下文（惰性）；继续对话时直接复用，不重建。
     * 创建时机相关的继承配置（计划模式、工具冻结、外部中断检查等）只在此处生效一次。
     */
    private void ensureLoop() {
        if (subLoop != null) return;
        ConversationContext ctx = new ConversationContext(
                new PromptPrefix(systemPrompt, registry.toOpenAiTools()));
        // 继承父级配置（config、sessionId、sessionUsageSink）和父代理的完整 HITL 模式。
        AgentConfig effectiveConfig = this.config;
        this.subLoop = new AgentLoop(modelProvider, registry, ctx, effectiveConfig);
        this.subLoop.setHitlMode(this.hitlMode);
        AgentLoop subLoop = this.subLoop;
        if (parentController != null) {
            subLoop.setTerminateOnNoToolCall(parentController.terminateOnNoToolCall());
        }
        if (abortRequested.get()) {
            subLoop.requestUserAbort();
            return;
        }

        // 同时观察显式子代理取消和父级用户中断，覆盖 run() 启动前后的竞争窗口。
        subLoop.setExternalAbortCheck(() -> abortRequested.get()
                || (parentController != null && parentController.isAbortRequested()));

        // 继承父级 sessionId 和 sessionUsageSink（用于 tools 中正确的会话上下文和用量上报）。
        // 文件变更必须由父循环统一 drain 并持久化；否则子循环会提前消费同一会话范围的记录，
        // 使主消息无法展示“已编辑 X 个文件”。
        if (sessionId != null) {
            subLoop.setSessionId(sessionId);
        }
        subLoop.setGoalGuardEnabled(false);
        subLoop.setDrainFileChanges(false);
        if (sessionUsageSink != null) {
            subLoop.setSessionUsageSink(sessionUsageSink);
        }
        // 继承父代理的计划模式：子代理同样被限制为只读工具
        // （必须在 freezePromptPrefix 前设置，冻结的工具列表才会过滤为只读集合）
        if (parentController != null && parentController.isPlanMode()) {
            subLoop.setPlanMode(true);
        }
        // 标记为子循环：状态通知渲染时据此避开 submit_plan 指引（子代理无该工具）
        subLoop.markSubAgentLoop();
        subLoop.freezePromptPrefix();
    }

    /**
     * 实际执行体（run 的 try/finally 保证记录器收尾）。
     * 支持多轮：首次调用创建子循环与上下文，后续调用（继续对话）复用同一循环累积消息。
     */
    private String doRun(String task, AgentLoopListener listener) throws IOException {
        ensureLoop();
        if (abortRequested.get()) {
            return "⏹️ 子代理已取消";
        }
        AgentLoop subLoop = this.subLoop;

        // 每轮执行：新建本轮输出链（新一轮 subId + 记录器续写新一轮 sub_start）
        // 输出目标优先取 outputTarget（继续对话的新 SSE 通道），否则回到父输出
        AgentOutput target = outputTarget != null ? outputTarget : parentOutput;
        if (target != null) {
            SubAgentAgentOutput wrapped = new SubAgentAgentOutput(target, task);
            this.subAgentId = wrapped.getSubId();
            AgentOutput effective = wrapped;
            // 挂载记录器：SSE 实时流保持 sub_* 不变，执行过程同时落盘为子代理会话
            SubAgentEventRecorder activeRecorder = this.recorder;
            if (activeRecorder != null) {
                // 会话名（name + 首句话）作为 sub_start 的任务字段：多轮续写同一名称，不回退为单轮消息；
                // name/title 一并落盘，供会话列表按名字 + 标题展示
                activeRecorder.attach(wrapped, sessionName != null ? sessionName : task,
                        agentName, sessionTitle, this.subAgentId);
                // 注入会话 id：桌面端子代理会话面板按 subSessionId 路由实时事件
                wrapped.setSubSessionId(activeRecorder.getSubSessionId());
                effective = activeRecorder;
            }
            subLoop.setOutput(effective);
        }

        // 创建用量捕获监听器：拦截 onUsage 记录到 SubAgent 字段，同时委托给外部 listener
        AgentLoopListener capturingListener = new AgentLoopListener() {
            @Override
            public void onReasoning(String r) {
                if (listener != null) listener.onReasoning(r);
            }

            @Override
            public void onToolCall(String n, String a) {
                if (listener != null) listener.onToolCall(n, a);
            }

            @Override
            public void onToolResult(String n, String r) {
                if (listener != null) listener.onToolResult(n, r);
            }

            @Override
            public void onUsage(String model, int prompt, int completion, int total,
                                int cacheHit, int cacheMiss) {
                if (sessionUsageSink != null) {
                    sessionUsageSink.addUsage(model, prompt, completion, cacheHit, cacheMiss);
                }
                // 委托给外部 listener
                if (listener != null) {
                    listener.onUsage(model, prompt, completion, total, cacheHit, cacheMiss);
                }
            }
        };
        subLoop.setListener(capturingListener);
        String result = subLoop.run(UserMessage.of(task));

        // ==================== HITL 暂停-恢复循环 ====================
        // 当子代理的 HitlManager 拦截工具调用时，mainLoop 返回 HITL prompt，
        // subLoop.hasPendingHITL() 为 true。此时阻塞等待用户审批，审批后通过
        // subLoop.run(null) 触发 cutin HITL 恢复，继续推理。
        // 如果子代理在执行中再次触发 HITL，while 循环会再次进入等待。
        while (subLoop.hasPendingHITL()) {
            // sub_choice 事件已由 HitlManager 通过 SubAgentAgentOutput 发送到前端
            log.info("[sub] 子代理 HITL 审批等待中, subId={}", subAgentId);

            // 注册到 Broker，然后轮询等待（每秒检查中断状态）
            SubAgentHITLBroker.Pending pending = SubAgentHITLBroker.register(subAgentId);
            boolean approved = false;
            boolean released = false;
            try {
                while (!released) {
                    released = pending.latch().await(1, TimeUnit.SECONDS);
                    // 检查父代理或用户是否已请求中断
                    if (!released && subLoop.isAbortRequested()) {
                        log.info("[sub] 子代理 HITL 被中断信号取消, subId={}", subAgentId);
                        SubAgentHITLBroker.resolve(subAgentId, false);
                        // 等待 resolve 生效
                        pending.latch().await(100, TimeUnit.MILLISECONDS);
                        released = true;
                    }
                }
                approved = pending.approved().get();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                approved = false;
            } finally {
                SubAgentHITLBroker.remove(subAgentId);
            }

            log.info("[sub] 子代理 HITL 审批结果: {}, subId={}", approved ? "批准" : "拒绝", subAgentId);
            if (approved) {
                subLoop.approveHITL();
            } else {
                subLoop.denyHITL();
            }
            result = subLoop.run(null); // 触发 cutin HITL 恢复，继续推理
        }

        return result;
    }
}
