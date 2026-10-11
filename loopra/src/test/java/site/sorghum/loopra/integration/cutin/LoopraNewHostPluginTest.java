package site.sorghum.loopra.integration.cutin;

import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;
import site.sorghum.cutin.core.context.DefaultLoopContext;
import site.sorghum.cutin.core.context.Message;
import site.sorghum.cutin.core.context.Usage;
import site.sorghum.cutin.core.event.LoopEvent;
import site.sorghum.cutin.core.loop.DefaultLoopEngine;
import site.sorghum.cutin.core.loop.InterceptPoint;
import site.sorghum.cutin.core.loop.InterceptionResult;
import site.sorghum.cutin.core.loop.LoopProgram;
import site.sorghum.cutin.core.loop.LoopResult;
import site.sorghum.cutin.core.loop.NodeType;
import site.sorghum.cutin.core.loop.StepResult;
import site.sorghum.cutin.core.loop.Steps;
import site.sorghum.cutin.core.model.ModelCallRequest;
import site.sorghum.cutin.core.model.ModelCapabilities;
import site.sorghum.cutin.core.model.ModelProvider;
import site.sorghum.cutin.core.model.ModelResponse;
import site.sorghum.cutin.core.model.StreamChunk;
import site.sorghum.cutin.core.plugin.DefaultLoopRegistrar;
import site.sorghum.cutin.core.plugin.PluginBeanManager;
import site.sorghum.loopra.bin.agent.model.ToolExecutionResult;
import site.sorghum.loopra.integration.cutin.plugin.exit.LoopraExitHost;
import site.sorghum.loopra.integration.cutin.plugin.exit.LoopraExitPlugin;
import site.sorghum.loopra.integration.cutin.plugin.plan.LoopraPlanHost;
import site.sorghum.loopra.integration.cutin.plugin.plan.LoopraPlanPlugin;
import site.sorghum.loopra.integration.cutin.plugin.preflight.LoopraPreflight;
import site.sorghum.loopra.integration.cutin.plugin.recovery.LoopraErrorRecoveryHost;
import site.sorghum.loopra.integration.cutin.plugin.recovery.LoopraErrorRecoveryPlugin;
import site.sorghum.loopra.integration.cutin.plugin.session.LoopraSessionHost;
import site.sorghum.loopra.integration.cutin.plugin.session.LoopraSessionPlugin;
import site.sorghum.loopra.integration.cutin.plugin.toolbatch.LoopraToolBatchHost;
import site.sorghum.loopra.integration.cutin.plugin.toolbatch.LoopraToolBatchPlugin;
import site.sorghum.loopra.tool.AgentOutput;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;

class LoopraNewHostPluginTest {

    @Test
    void exitPluginCanVetoExitAndContinue() {
        DefaultLoopEngine engine = new DefaultLoopEngine();
        AtomicInteger modelRuns = new AtomicInteger();
        ToggleExitHost host = new ToggleExitHost();
        PluginBeanManager manager = new PluginBeanManager(engine.registrar());
        manager.registerPlugin(new LoopraExitPlugin(host));
        manager.startAll();

        LoopProgram program = LoopProgram.builder("exit")
            .node("model", NodeType.CODE, ignored -> {
                modelRuns.incrementAndGet();
                return StepResult.Continue.INSTANCE;
            })
            .node("out", NodeType.OUTPUT, Steps.finish())
            .next("model", "out")
            .start("model")
            .build();
        LoopResult result = engine.run(program, engine.newContext("ctx", Map.of())).result().join();

        assertEquals(LoopResult.Status.COMPLETED, result.status());
        assertEquals(2, modelRuns.get());
    }

    @Test
    void errorRecoveryPluginRetriesContextOverflow() {
        DefaultLoopEngine engine = new DefaultLoopEngine();
        AtomicInteger calls = new AtomicInteger();
        engine.addModelProvider(new OverflowOnceProvider(calls));
        RecoveryStub host = new RecoveryStub();
        PluginBeanManager manager = new PluginBeanManager(engine.registrar());
        manager.registerPlugin(new LoopraErrorRecoveryPlugin(host));
        manager.startAll();

        LoopProgram program = LoopProgram.builder("recover")
            .node("model", NodeType.MODEL, Steps.streamModelFromContext("fake"))
            .node("out", NodeType.OUTPUT, Steps.finish())
            .next("model", "out")
            .start("model")
            .build();
        LoopResult result = engine.run(program, engine.newContext("ctx", Map.of())).result().join();

        assertEquals(LoopResult.Status.COMPLETED, result.status());
        assertEquals(2, calls.get());
        assertEquals(1, host.compacts.size());
    }

    @Test
    void sessionPluginFiresBeforeAndAfterTurn() {
        DefaultLoopEngine engine = new DefaultLoopEngine();
        SessionStub host = new SessionStub();
        PluginBeanManager manager = new PluginBeanManager(engine.registrar());
        manager.registerPlugin(new LoopraSessionPlugin(host));
        manager.startAll();

        LoopProgram program = LoopProgram.builder("session")
            .node(LoopraPreflight.SANITIZE_NODE, NodeType.CODE, context -> {
                context.putVariable("loopraUserMessage", "帮我分析项目");
                return StepResult.Continue.INSTANCE;
            })
            .node("out", NodeType.OUTPUT, Steps.finish())
            .next(LoopraPreflight.SANITIZE_NODE, "out")
            .start(LoopraPreflight.SANITIZE_NODE)
            .build();
        engine.run(program, engine.newContext("ctx", Map.of())).result().join();

        assertEquals(1, host.beforeTurns.get());
        assertEquals("帮我分析项目", host.messages.get(0));
        assertEquals(1, host.afterTurns.get());
    }

    @Test
    void toolBatchPluginRegistersAllLifecyclePoints() {
        DefaultLoopEngine engine = new DefaultLoopEngine();
        DefaultLoopRegistrar registrar = (DefaultLoopRegistrar) engine.registrar();
        new LoopraToolBatchPlugin(new ToolBatchStub()).register(registrar);

        assertEquals(1, registrar.interceptors().size(InterceptPoint.BEFORE_TOOL_BATCH));
        assertEquals(1, registrar.interceptors().size(InterceptPoint.AFTER_TOOL_BATCH));
        assertEquals(1, registrar.interceptors().size(InterceptPoint.ON_TOOL_TIMEOUT));
        assertEquals(1, registrar.interceptors().size(InterceptPoint.ON_TOOL_CANCEL));
    }

    @Test
    void toolBatchPluginCanSuspendForSandboxHitl() {
        DefaultLoopEngine engine = new DefaultLoopEngine();
        PluginBeanManager manager = new PluginBeanManager(engine.registrar());
        manager.registerPlugin(new LoopraToolBatchPlugin(new SuspendBatchStub()));
        manager.startAll();

        InterceptionResult result = engine.intercept(
                InterceptPoint.AFTER_TOOL_BATCH,
                "tool",
                engine.newContext("ctx", Map.of()),
                "batch");

        assertEquals(true, result.decision().isSuspend());
        assertEquals("approval required", result.decision().reason());
    }

    @Test
    void planPluginPersistsSubmittedAndClearedPlans() {
        DefaultLoopEngine engine = new DefaultLoopEngine();
        PlanStub host = new PlanStub();
        PluginBeanManager manager = new PluginBeanManager(engine.registrar());
        manager.registerPlugin(new LoopraPlanPlugin(host));
        manager.startAll();

        engine.events().emit(new LoopEvent(
                LoopraPlanHost.PLAN_SUBMITTED,
                "plan",
                null,
                Map.of("plan", "1. inspect\n2. implement")
        ));
        engine.events().emit(new LoopEvent(
                LoopraPlanHost.PLAN_CLEARED,
                "plan",
                null,
                Map.of("plan", "")
        ));

        assertEquals(2, host.plans.size());
        assertEquals("1. inspect\n2. implement", host.plans.get(0));
        assertEquals(null, host.plans.get(1));
    }

    private static final class ToggleExitHost implements LoopraExitHost {

        private int calls;

        @Override
        public boolean continueAfterExit(DefaultLoopContext context) {
            calls++;
            return calls == 1;
        }
    }

    private static final class RecoveryStub implements LoopraErrorRecoveryHost {

        private final List<Integer> compacts = new CopyOnWriteArrayList<>();

        @Override
        public int maxContextRecoveries() {
            return 2;
        }

        @Override
        public boolean compactAfterContextOverflow(int recoveryAttempt) {
            compacts.add(recoveryAttempt);
            return true;
        }
    }

    private static final class SessionStub implements LoopraSessionHost {

        @Override
        public void beginCutinLoop() {
        }

        @Override
        public void endCutinLoop() {
        }

        private final AtomicInteger beforeTurns = new AtomicInteger();
        private final AtomicInteger afterTurns = new AtomicInteger();
        private final List<String> messages = new CopyOnWriteArrayList<>();

        @Override
        public void beforeTurn(String userMessage) {
            beforeTurns.incrementAndGet();
            messages.add(userMessage);
        }

        @Override
        public void afterTurn() {
            afterTurns.incrementAndGet();
        }
    }

    private static final class ToolBatchStub implements LoopraToolBatchHost {

        @Override
        public AgentOutput getOutput() {
            return AgentOutput.NOOP;
        }

        @Override
        public String suspendSandboxHITLIfPending(DefaultLoopContext context) {
            return null;
        }

        @Override
        public void applySelfCorrection(DefaultLoopContext context, ToolExecutionResult result) {
        }
    }

    private static final class SuspendBatchStub implements LoopraToolBatchHost {

        @Override
        public AgentOutput getOutput() {
            return AgentOutput.NOOP;
        }

        @Override
        public String suspendSandboxHITLIfPending(DefaultLoopContext context) {
            return "approval required";
        }

        @Override
        public void applySelfCorrection(DefaultLoopContext context, ToolExecutionResult result) {
        }
    }

    private static final class PlanStub implements LoopraPlanHost {

        private final List<String> plans = new CopyOnWriteArrayList<>();

        @Override
        public void persistPendingPlan(String planMarkdown) {
            plans.add(planMarkdown);
        }
    }

    private static final class OverflowOnceProvider implements ModelProvider {

        private final AtomicInteger calls;

        private OverflowOnceProvider(AtomicInteger calls) {
            this.calls = calls;
        }

        @Override
        public String id() {
            return "fake";
        }

        @Override
        public ModelResponse call(ModelCallRequest request) {
            return new ModelResponse(new Message("assistant", "ok"), Usage.ZERO, true);
        }

        @Override
        public Stream<StreamChunk> stream(ModelCallRequest request) {
            if (calls.incrementAndGet() == 1) {
                return Stream.of(new StreamChunk(
                    "",
                    null,
                    List.of(),
                    List.of(),
                    Usage.ZERO,
                    Map.of("error", "context_length_exceeded"),
                    true
                ));
            }
            return Stream.of(new StreamChunk("ok", Usage.ZERO));
        }

        @Override
        public ModelCapabilities capabilities() {
            return new ModelCapabilities(Set.of("fake"), true, true);
        }

        @Override
        public ONode buildBody(ModelCallRequest request, boolean stream) {
            return null;
        }
    }
}
