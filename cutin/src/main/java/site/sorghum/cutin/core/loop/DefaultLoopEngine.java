package site.sorghum.cutin.core.loop;

import site.sorghum.cutin.core.context.Budget;
import site.sorghum.cutin.core.context.DefaultLoopContext;
import site.sorghum.cutin.core.context.LoopContext;
import site.sorghum.cutin.core.context.Message;
import site.sorghum.cutin.core.event.EventBus;
import site.sorghum.cutin.core.event.EventHandler;
import site.sorghum.cutin.core.event.Hook;
import site.sorghum.cutin.core.event.LoopEvent;
import site.sorghum.cutin.core.model.DefaultModelGateway;
import site.sorghum.cutin.core.model.InterceptingModelGateway;
import site.sorghum.cutin.core.model.ModelGateway;
import site.sorghum.cutin.core.model.ModelProvider;
import site.sorghum.cutin.core.model.ModelRegistry;
import site.sorghum.cutin.core.plugin.DefaultLoopRegistrar;
import site.sorghum.cutin.core.plugin.LoopRegistrar;
import site.sorghum.cutin.core.plugin.Registration;
import site.sorghum.cutin.core.state.CheckpointManager;
import site.sorghum.cutin.core.state.InMemoryStateStore;
import site.sorghum.cutin.core.state.LoopSnapshot;
import site.sorghum.cutin.core.state.StateStore;
import site.sorghum.cutin.core.tool.DefaultToolRegistry;
import site.sorghum.cutin.core.tool.InterceptingToolRegistry;
import site.sorghum.cutin.core.tool.Tool;
import site.sorghum.cutin.core.tool.ToolProvider;
import site.sorghum.cutin.core.tool.ToolRegistry;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 默认循环引擎：状态机式推进 {@link LoopProgram}，并承担注册中心职责。
 *
 * <p>引擎维护拦截器、工具、模型、事件、快照与检查点等基础设施；
 * 每个节点执行前写入检查点，节点间按程序边流转，并处理
 * StepResult 与各类控制流异常。引擎不实现业务策略，全部扩展通过
 * 拦截器、Provider 与插件 SPI 注入。</p>
 */
public final class DefaultLoopEngine implements LoopEngine, LoopRegistrar {

    /** 统一注册中心。 */
    private final DefaultLoopRegistrar registrar;
    /** 拦截器注册表。 */
    private final InterceptorRegistry interceptors;
    /** 工具注册表。 */
    private final ToolRegistry tools;
    /** 模型注册表。 */
    private final ModelRegistry models;
    /** 事件总线。 */
    private final EventBus events;
    /** 带拦截链的模型网关。 */
    private final ModelGateway modelGateway;
    /** 带拦截链的工具网关。 */
    private final ToolRegistry toolGateway;
    /** 状态存储。 */
    private final StateStore stateStore;
    /** 检查点管理器。 */
    private final CheckpointManager checkpoints;
    /** 循环 id 到句柄的映射。 */
    private final Map<String, DefaultLoopHandle> handles = new ConcurrentHashMap<>();

    /** 使用内存状态存储创建引擎。 */
    public DefaultLoopEngine() {
        this(new InMemoryStateStore());
    }

    /** 使用指定状态存储创建引擎，工具与模型注册表使用默认实现。 */
    public DefaultLoopEngine(StateStore stateStore) {
        this(
            stateStore,
            new DefaultToolRegistry(),
            new ModelRegistry()
        );
    }

    /** 使用外部工具与模型注册表创建引擎。 */
    public DefaultLoopEngine(ToolRegistry toolRegistry, ModelRegistry modelRegistry) {
        this(new InMemoryStateStore(), toolRegistry, modelRegistry);
    }

    /** 完整构造：装配拦截链、事件总线与检查点管理器。 */
    public DefaultLoopEngine(
        StateStore stateStore,
        ToolRegistry toolRegistry,
        ModelRegistry modelRegistry
    ) {
        this.stateStore = stateStore;
        this.registrar = new DefaultLoopRegistrar(
            new InterceptorRegistry(),
            toolRegistry,
            modelRegistry,
            new EventBus()
        );
        this.interceptors = registrar.interceptors();
        this.tools = registrar.tools();
        this.models = registrar.models();
        this.events = registrar.events();
        this.modelGateway = new InterceptingModelGateway(new DefaultModelGateway(models), interceptors, events);
        this.toolGateway = new InterceptingToolRegistry(tools, interceptors);
        this.checkpoints = new CheckpointManager(stateStore, events);
    }

    /** 获取内部注册中心，便于插件注册扩展点。 */
    public LoopRegistrar registrar() {
        return registrar;
    }

    /** 获取状态存储。 */
    public StateStore stateStore() {
        return stateStore;
    }

    /** 获取检查点管理器。 */
    public CheckpointManager checkpoints() {
        return checkpoints;
    }

    /** 获取事件总线。 */
    public EventBus events() {
        return events;
    }

    /** 使用显式上下文启动循环并创建句柄。 */
    @Override
    public LoopHandle run(LoopProgram program, LoopContext initialContext) {
        DefaultLoopContext context = requireContext(initialContext);
        DefaultLoopHandle handle = new DefaultLoopHandle(context.id(), this, program);
        handles.put(handle.id(), handle);
        handle.start(context);
        return handle;
    }

    /** 使用输入变量创建新上下文并启动循环。 */
    @Override
    public LoopHandle run(LoopProgram program, Map<String, Object> input) {
        String loopId = UUID.randomUUID().toString();
        return run(program, newContext(loopId, input));
    }

    /** 从输入变量创建上下文：提取 message 与 budget 特殊键，其余作为普通变量。 */
    public DefaultLoopContext newContext(String loopId, Map<String, Object> input) {
        return newContext(loopId, input, null);
    }

    /** 从输入变量创建上下文，并显式指定工具相对路径的基准目录。 */
    public DefaultLoopContext newContext(String loopId, Map<String, Object> input, Path workingDirectory) {
        Map<String, Object> variables = new HashMap<>(input == null ? Map.of() : input);
        Object messageValue = variables.remove("message");
        Object budgetValue = variables.remove("budget");

        List<Message> messages = new ArrayList<>();
        if (messageValue != null && !String.valueOf(messageValue).isBlank()) {
            messages.add(new Message("user", String.valueOf(messageValue)));
        }
        Budget budget = budgetValue instanceof Budget candidate ? candidate : Budget.unlimited();
        return new DefaultLoopContext(loopId, messages, variables, budget, modelGateway, toolGateway, workingDirectory);
    }

    /** 用完整初始数据创建上下文。 */
    public DefaultLoopContext newContext(
        String loopId,
        List<Message> initialMessages,
        Map<String, Object> variables,
        Budget budget
    ) {
        return newContext(loopId, initialMessages, variables, budget, null);
    }

    /** 用完整初始数据创建上下文，并显式指定工作目录。 */
    public DefaultLoopContext newContext(
        String loopId,
        List<Message> initialMessages,
        Map<String, Object> variables,
        Budget budget,
        Path workingDirectory
    ) {
        return new DefaultLoopContext(
            loopId,
            initialMessages,
            variables,
            budget,
            modelGateway,
            toolGateway,
            workingDirectory
        );
    }

    /** 从快照恢复上下文。 */
    public DefaultLoopContext restore(LoopSnapshot snapshot) {
        return new DefaultLoopContext(snapshot, modelGateway, toolGateway);
    }

    /** 从状态存储按版本恢复上下文。 */
    public DefaultLoopContext restore(String loopId, long stateVersion) {
        LoopSnapshot snapshot = stateStore.version(loopId, stateVersion)
            .orElseThrow(() -> new IllegalArgumentException(
                "no snapshot for loop " + loopId + " at version " + stateVersion
            ));
        return restore(snapshot);
    }

    /**
     * 执行完整的一轮循环，并在整轮结束后运行 AFTER_TURN 拦截。
     */
    LoopResult execute(
        LoopProgram program,
        DefaultLoopContext context,
        DefaultLoopHandle handle,
        String entryNodeId,
        boolean reentry
    ) {
        LoopResult result = executeInner(program, context, handle, entryNodeId, reentry);
        InterceptionResult afterTurn = interceptors.run(
            InterceptPoint.AFTER_TURN,
            new InterceptContext(InterceptPoint.AFTER_TURN, result.nodeId(), null, null, result)
        );
        if (afterTurn.payload() instanceof LoopResult replacement) {
            result = replacement;
        }
        events.emit(new LoopEvent(
            "AFTER_TURN",
            result.loopId(),
            result.nodeId(),
            Map.of("result", result, "status", result.status().name())
        ));
        return result;
    }

    /**
     * 循环主体：按节点图推进，处理检查点、拦截决策、StepResult 与控制流异常。
     *
     * <p>每个节点先做快照，再依次处理 BEFORE_STEP 决策；OUTPUT 节点额外
     * 运行 BEFORE_OUTPUT；Step 执行后运行 AFTER_STEP。
     * 循环自然结束后通过 {@link #decideExit} 运行 BEFORE_EXIT，
     * 允许插件替换结果或继续跳转。</p>
     */
    private LoopResult executeInner(
        LoopProgram program,
        DefaultLoopContext context,
        DefaultLoopHandle handle,
        String entryNodeId,
        boolean reentry
    ) {
        String loopId = context.id();
        String nodeId = entryNodeId != null ? entryNodeId : program.startNodeId();
        events.emit(new LoopEvent(
            "PRE_LOOP",
            loopId,
            nodeId,
            Map.of("program", program.id(), "context", context)
        ));

        try {
            if (reentry) {
                context.budget().reenter();
                events.emit(new LoopEvent("ON_REENTER", loopId, nodeId, Map.of("reason", "reentry")));
            }

            while (true) {
                while (nodeId != null) {
                    if (handle.isCancelled()) {
                        return result(handle, context, LoopResult.Status.CANCELLED, nodeId, "cancelled");
                    }
                    if (!context.budget().canStep()) {
                        return result(handle, context, LoopResult.Status.FAILED, nodeId, "step budget exceeded");
                    }
                    context.budget().step();

                    LoopNode node = program.node(nodeId);
                    LoopSnapshot snapshot = checkpoints.checkpoint(loopId, context, nodeId);
                    handle.updateSnapshot(snapshot);

                    InterceptionResult before = interceptors.run(
                        InterceptPoint.BEFORE_STEP,
                        new InterceptContext(InterceptPoint.BEFORE_STEP, nodeId, node, context)
                    );
                    context = requireContext(before.context());
                    if (before.decision().isAbort()) {
                        return result(handle, context, LoopResult.Status.ABORTED, nodeId, before.decision().reason());
                    }
                    if (before.decision().isSuspend()) {
                        return result(handle, context, LoopResult.Status.SUSPENDED, nodeId, before.decision().reason());
                    }
                    if (before.decision().isSkipStep()) {
                        nodeId = program.next(nodeId);
                        continue;
                    }
                    if (before.decision().isGoto()) {
                        nodeId = before.decision().targetNodeId();
                        continue;
                    }
                    if (before.decision().isRetry()) {
                        continue;
                    }

                    if (node.type() == NodeType.OUTPUT) {
                        InterceptionResult beforeOutput = interceptors.run(
                            InterceptPoint.BEFORE_OUTPUT,
                            new InterceptContext(InterceptPoint.BEFORE_OUTPUT, nodeId, node, context)
                        );
                        context = requireContext(beforeOutput.context());
                        if (beforeOutput.decision().isAbort()) {
                            return result(handle, context, LoopResult.Status.ABORTED, nodeId, beforeOutput.decision().reason());
                        }
                        if (beforeOutput.decision().isSuspend()) {
                            return result(handle, context, LoopResult.Status.SUSPENDED, nodeId, beforeOutput.decision().reason());
                        }
                        if (beforeOutput.decision().isSkipStep()) {
                            nodeId = program.next(nodeId);
                            continue;
                        }
                        if (beforeOutput.decision().isGoto()) {
                            nodeId = beforeOutput.decision().targetNodeId();
                            continue;
                        }
                        if (beforeOutput.decision().isRetry()) {
                            continue;
                        }
                    }

                    StepResult stepResult;
                    try {
                        stepResult = node.step().execute(context);
                    } catch (LoopRetryException exception) {
                        InterceptionResult beforeRetry = interceptors.run(
                            InterceptPoint.BEFORE_RETRY,
                            new InterceptContext(InterceptPoint.BEFORE_RETRY, nodeId, node, context, exception)
                        );
                        context = requireContext(beforeRetry.context());
                        if (beforeRetry.decision().isAbort()) {
                            return result(handle, context, LoopResult.Status.ABORTED, nodeId, beforeRetry.decision().reason());
                        }
                        if (beforeRetry.decision().isSuspend()) {
                            return result(handle, context, LoopResult.Status.SUSPENDED, nodeId, beforeRetry.decision().reason());
                        }
                        if (beforeRetry.decision().isGoto()) {
                            nodeId = beforeRetry.decision().targetNodeId();
                            continue;
                        }
                        if (beforeRetry.decision().isSkipStep()) {
                            nodeId = program.next(nodeId);
                            continue;
                        }
                        continue;
                    } catch (LoopGotoException exception) {
                        nodeId = exception.targetNodeId();
                        continue;
                    } catch (LoopAbortException exception) {
                        return result(handle, context, LoopResult.Status.ABORTED, nodeId, exception.getMessage());
                    } catch (LoopSuspendException exception) {
                        return result(handle, context, LoopResult.Status.SUSPENDED, nodeId, exception.getMessage());
                    } catch (RuntimeException exception) {
                        events.emit(new LoopEvent("ON_ERROR", loopId, nodeId, Map.of("error", message(exception))));
                        return result(handle, context, LoopResult.Status.FAILED, nodeId, message(exception));
                    }

                    InterceptionResult after = interceptors.run(
                        InterceptPoint.AFTER_STEP,
                        new InterceptContext(InterceptPoint.AFTER_STEP, nodeId, node, context)
                    );
                    context = requireContext(after.context());
                    if (after.decision().isAbort()) {
                        return result(handle, context, LoopResult.Status.ABORTED, nodeId, after.decision().reason());
                    }
                    if (after.decision().isSuspend()) {
                        return result(handle, context, LoopResult.Status.SUSPENDED, nodeId, after.decision().reason());
                    }
                    if (after.decision().isGoto()) {
                        nodeId = after.decision().targetNodeId();
                        continue;
                    }
                    if (after.decision().isRetry()) {
                        continue;
                    }
                    if (after.decision().isSkipStep()) {
                        nodeId = program.next(nodeId);
                        continue;
                    }

                    if (stepResult instanceof StepResult.Suspend suspendResult) {
                        return result(handle, context, LoopResult.Status.SUSPENDED, nodeId, suspendResult.reason());
                    }
                    if (stepResult instanceof StepResult.Fail failResult) {
                        events.emit(new LoopEvent("ON_ERROR", loopId, nodeId, Map.of("error", failResult.reason())));
                        return result(handle, context, LoopResult.Status.FAILED, nodeId, failResult.reason());
                    }
                    if (stepResult instanceof StepResult.Exit) {
                        ExitDecision exit = decideExit(handle, context, nodeId);
                        if (!exit.exit()) {
                            nodeId = exit.continueNodeId();
                            context = exit.context();
                            continue;
                        }
                        return completeLoop(handle, context, nodeId, exit.result());
                    }
                    LoopSnapshot afterSnapshot = checkpoints.checkpoint(loopId, context, nodeId);
                    handle.updateSnapshot(afterSnapshot);
                    nodeId = nextNode(program, nodeId, stepResult);
                }

                ExitDecision exit = decideExit(handle, context, nodeId);
                if (!exit.exit()) {
                    nodeId = exit.continueNodeId();
                    context = exit.context();
                    continue;
                }
                return completeLoop(handle, context, nodeId, exit.result());
            }
        } catch (RuntimeException exception) {
            events.emit(new LoopEvent("ON_ERROR", loopId, nodeId, Map.of("error", message(exception))));
            LoopSnapshot snapshot = checkpoints.latest(loopId).orElse(context.snapshot());
            return new LoopResult(loopId, LoopResult.Status.FAILED, nodeId, message(exception), snapshot);
        }
    }

    /**
     * 在节点主循环之外运行一条临时拦截链（工具批量、超时、取消等场景）。
     */
    public InterceptionResult intercept(
        InterceptPoint point,
        String nodeId,
        LoopContext context,
        Object payload
    ) {
        return interceptors.run(point, new InterceptContext(point, nodeId, null, context, payload));
    }

    /**
     * 决定是否真正退出：运行 BEFORE_EXIT 拦截链。
     *
     * <p>拦截器可以返回 GOTO 继续执行、RETRY 重试当前节点、
     * ABORT/SUSPEND 结束，或替换最终 {@link LoopResult}。</p>
     */
    private ExitDecision decideExit(DefaultLoopHandle handle, DefaultLoopContext context, String nodeId) {
        LoopResult provisional = new LoopResult(
            handle.id(),
            LoopResult.Status.COMPLETED,
            nodeId,
            "completed",
            context.snapshot()
        );
        InterceptionResult before = interceptors.run(
            InterceptPoint.BEFORE_EXIT,
            new InterceptContext(InterceptPoint.BEFORE_EXIT, nodeId, null, context, provisional)
        );
        DefaultLoopContext effective = requireContext(before.context());
        InterceptDecision decision = before.decision();
        if (decision.isGoto()) {
            return new ExitDecision(false, null, decision.targetNodeId(), effective);
        }
        if (decision.isRetry()) {
            return new ExitDecision(false, null, nodeId, effective);
        }
        if (decision.isAbort()) {
            return new ExitDecision(
                true,
                result(handle, effective, LoopResult.Status.ABORTED, nodeId, decision.reason()),
                null,
                effective
            );
        }
        if (decision.isSuspend()) {
            return new ExitDecision(
                true,
                result(handle, effective, LoopResult.Status.SUSPENDED, nodeId, decision.reason()),
                null,
                effective
            );
        }
        LoopResult finalResult = before.payload() instanceof LoopResult replacement ? replacement : provisional;
        return new ExitDecision(true, finalResult, null, effective);
    }

    /** 正常结束循环：写入最终检查点、发布 POST_LOOP 事件并返回结果。 */
    private LoopResult completeLoop(
        DefaultLoopHandle handle,
        DefaultLoopContext context,
        String nodeId,
        LoopResult result
    ) {
        LoopSnapshot checkpoint = checkpoints.checkpoint(handle.id(), context, nodeId);
        LoopSnapshot snapshot = result.finalSnapshot() != null
            ? result.finalSnapshot()
            : checkpoint;
        handle.updateSnapshot(snapshot);
        events.emit(new LoopEvent(
            "POST_LOOP",
            handle.id(),
            nodeId,
            Map.of("status", result.status().name())
        ));
        return result.withSnapshot(snapshot);
    }

    /** 退出决策记录：是否退出、最终结果、继续执行的节点与新上下文。 */
    private record ExitDecision(
        boolean exit,
        LoopResult result,
        String continueNodeId,
        DefaultLoopContext context
    ) {
    }

    /** 保存退出时的当前状态，避免暂停后恢复到节点执行前的旧检查点。 */
    private LoopResult result(DefaultLoopHandle handle, DefaultLoopContext context,
                              LoopResult.Status status, String nodeId, String message) {
        LoopSnapshot snapshot = checkpoints.checkpoint(handle.id(), context, nodeId);
        handle.updateSnapshot(snapshot);
        return new LoopResult(handle.id(), status, nodeId, message, snapshot);
    }

    /** 根据 StepResult 决定下一个节点。 */
    private String nextNode(LoopProgram program, String nodeId, StepResult stepResult) {
        if (stepResult instanceof StepResult.Goto gotoResult) {
            return gotoResult.targetNodeId();
        }
        if (stepResult instanceof StepResult.Repeat) {
            return nodeId;
        }
        if (stepResult instanceof StepResult.Exit) {
            return null;
        }
        return program.next(nodeId);
    }

    /** 当前只支持默认上下文实现，自定义上下文实现暂未开放。 */
    private static DefaultLoopContext requireContext(LoopContext context) {
        if (context instanceof DefaultLoopContext defaultContext) {
            return defaultContext;
        }
        throw new IllegalArgumentException("custom LoopContext implementations are not supported yet");
    }

    /** 取异常消息，没有消息时退回类名。 */
    private static String message(Throwable throwable) {
        return throwable.getMessage() == null ? throwable.getClass().getSimpleName() : throwable.getMessage();
    }

    /** 注册拦截器。 */
    @Override
    public void addInterceptor(InterceptPoint point, int order, LoopInterceptor interceptor) { registrar.addInterceptor(point, order, interceptor); }

    @Override
    public Registration registerInterceptor(InterceptPoint point, int order, LoopInterceptor interceptor) { return registrar.registerInterceptor(point, order, interceptor); }

    /** 注册工具。 */
    @Override
    public void addTool(Tool tool) { registrar.addTool(tool); }

    @Override
    public Registration registerTool(Tool tool) { return registrar.registerTool(tool); }

    /** 注册工具提供方。 */
    @Override
    public void addToolProvider(ToolProvider provider) { registrar.addToolProvider(provider); }

    @Override
    public Registration registerToolProvider(ToolProvider provider) { return registrar.registerToolProvider(provider); }

    /** 注册模型 Provider。 */
    @Override
    public void addModelProvider(ModelProvider provider) { registrar.addModelProvider(provider); }

    @Override
    public Registration registerModelProvider(ModelProvider provider) { return registrar.registerModelProvider(provider); }

    /** 注册事件处理器。 */
    @Override
    public void addEventHandler(EventHandler handler) { registrar.addEventHandler(handler); }

    @Override
    public Registration registerEventHandler(EventHandler handler) { return registrar.registerEventHandler(handler); }

    /** 注册 Hook。 */
    @Override
    public void addHook(Hook hook) { registrar.addHook(hook); }

    @Override
    public Registration registerHook(Hook hook) { return registrar.registerHook(hook); }

}
