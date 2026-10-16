package site.sorghum.cutin.core.loop;

import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;
import site.sorghum.cutin.core.context.DefaultLoopContext;
import site.sorghum.cutin.core.context.Message;
import site.sorghum.cutin.core.context.Usage;
import site.sorghum.cutin.core.event.Hook;
import site.sorghum.cutin.core.event.LoopEvent;
import site.sorghum.cutin.core.model.ModelCallRequest;
import site.sorghum.cutin.core.model.ModelCapabilities;
import site.sorghum.cutin.core.model.ModelProvider;
import site.sorghum.cutin.core.model.ModelResponse;
import site.sorghum.cutin.core.model.StreamChunk;
import site.sorghum.cutin.core.state.LoopSnapshot;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * 退出、错误、取消与临时拦截链测试。
 *
 * <p>覆盖 BEFORE_EXIT 替换结果/继续跳转、AFTER_TURN 替换结果、
 * 模型流错误重试、取消事件、临时拦截载荷与重入产物覆盖。</p>
 */
class ExitTurnErrorHookTest {

    /** BEFORE_EXIT 应能替换最终结果。 */
    @Test
    void beforeExitCanReplaceFinalResult() {
        DefaultLoopEngine engine = new DefaultLoopEngine();
        engine.addInterceptor(InterceptPoint.BEFORE_EXIT, 0, context -> {
            LoopResult original = (LoopResult) context.payload();
            return InterceptDecision.modified(
                context.context(),
                original.withMessage("plugin result")
            );
        });

        LoopProgram program = LoopProgram.builder("exit-replace")
            .node("out", NodeType.OUTPUT, Steps.finish())
            .start("out")
            .build();
        DefaultLoopContext context = engine.newContext("ctx", Map.of());

        LoopResult result = engine.run(program, context).result().join();

        assertEquals(LoopResult.Status.COMPLETED, result.status());
        assertEquals("plugin result", result.message());
    }

    /** BEFORE_EXIT 应能通过 GOTO 让循环继续执行。 */
    @Test
    void beforeExitCanGotoToContinueTheLoop() {
        DefaultLoopEngine engine = new DefaultLoopEngine();
        AtomicInteger modelRuns = new AtomicInteger();
        AtomicInteger exits = new AtomicInteger();
        engine.addInterceptor(InterceptPoint.BEFORE_EXIT, 0, context -> {
            if (exits.incrementAndGet() < 2) {
                return InterceptDecision.gotoNode("model");
            }
            return InterceptDecision.pass();
        });

        LoopProgram program = LoopProgram.builder("exit-goto")
            .node("model", NodeType.CODE, ignored -> {
                modelRuns.incrementAndGet();
                return StepResult.Continue.INSTANCE;
            })
            .node("out", NodeType.OUTPUT, Steps.finish())
            .next("model", "out")
            .start("model")
            .build();
        DefaultLoopContext context = engine.newContext("ctx", Map.of());

        LoopResult result = engine.run(program, context).result().join();

        assertEquals(LoopResult.Status.COMPLETED, result.status());
        assertEquals(2, modelRuns.get());
    }

    /** AFTER_TURN 应能替换整轮的最终结果。 */
    @Test
    void afterTurnCanReplaceFinalResult() {
        DefaultLoopEngine engine = new DefaultLoopEngine();
        engine.addInterceptor(InterceptPoint.AFTER_TURN, 0, context -> {
            LoopResult original = (LoopResult) context.payload();
            return InterceptDecision.replace(original.withMessage("after turn"));
        });

        LoopProgram program = LoopProgram.builder("after-turn")
            .node("out", NodeType.OUTPUT, Steps.finish())
            .start("out")
            .build();

        LoopResult result = engine.run(program, engine.newContext("ctx", Map.of())).result().join();

        assertEquals("after turn", result.message());
    }

    /** 模型流错误终止块应能触发同节点重试。 */
    @Test
    void modelStreamErrorCanRetryTheSameNode() {
        DefaultLoopEngine engine = new DefaultLoopEngine();
        AtomicInteger calls = new AtomicInteger();
        engine.addModelProvider(new FlakyProvider(calls));
        engine.addInterceptor(InterceptPoint.ON_MODEL_ERROR, 0, context ->
            InterceptDecision.retry("recovered"));

        LoopProgram program = LoopProgram.builder("model-retry")
            .node("model", NodeType.MODEL, Steps.streamModelFromContext("fake"))
            .node("out", NodeType.OUTPUT, Steps.finish())
            .next("model", "out")
            .start("model")
            .build();

        LoopResult result = engine.run(program, engine.newContext("ctx", Map.of())).result().join();

        assertEquals(LoopResult.Status.COMPLETED, result.status());
        assertEquals(2, calls.get());
        assertEquals("ok", result.finalSnapshot().messages().get(0).content());
    }

    /** 取消循环应发布 ON_CANCEL 事件并携带原因。 */
    @Test
    void cancelEmitsOnCancelEvent() throws Exception {
        DefaultLoopEngine engine = new DefaultLoopEngine();
        List<String> reasons = new CopyOnWriteArrayList<>();
        engine.addHook(new Hook() {
            @Override
            public String id() {
                return "cancel-test";
            }

            @Override
            public boolean matches(LoopEvent event) {
                return "ON_CANCEL".equals(event.type());
            }

            @Override
            public void run(LoopEvent event) {
                reasons.add(String.valueOf(event.attributes().get("reason")));
            }
        });
        LoopProgram program = LoopProgram.builder("cancel")
            .node("out", NodeType.OUTPUT, Steps.finish())
            .start("out")
            .build();
        LoopHandle handle = engine.run(program, engine.newContext("ctx", Map.of()));
        handle.result().join();
        handle.cancel(CancelReason.USER);

        assertEquals(List.of("user"), reasons);
    }

    /** 临时拦截链应能把载荷替换为指定值。 */
    @Test
    void adHocInterceptSupportsToolBatchPayload() {
        DefaultLoopEngine engine = new DefaultLoopEngine();
        AtomicReference<Object> seen = new AtomicReference<>();
        engine.addInterceptor(InterceptPoint.BEFORE_TOOL_BATCH, 0, context -> {
            seen.set(context.payload());
            return InterceptDecision.replace("replaced");
        });

        InterceptionResult result = engine.intercept(
            InterceptPoint.BEFORE_TOOL_BATCH,
            "tool",
            engine.newContext("ctx", Map.of()),
            "original"
        );

        assertEquals("original", seen.get());
        assertEquals("replaced", result.payload());
    }

    /** 重入应能把产物覆盖表注入上下文。 */
    @Test
    void reentryCanOverrideArtifacts() throws Exception {
        DefaultLoopEngine engine = new DefaultLoopEngine();
        LoopProgram program = LoopProgram.builder("reentry-artifact")
            .node("read", NodeType.CODE, context -> {
                context.putVariable("seen", context.artifacts().get("data"));
                return StepResult.Exit.INSTANCE;
            })
            .start("read")
            .build();
        LoopHandle handle = engine.run(program, engine.newContext("ctx", Map.of()));
        LoopResult first = handle.result().get(5, TimeUnit.SECONDS);
        LoopSnapshot snapshot = handle.snapshot();

        LoopResult second = handle.reenter(new ReentryRequest(
            "read",
            snapshot.stateVersion(),
            Map.of(),
            Map.of("data", "artifact-value"),
            "retry"
        )).get(5, TimeUnit.SECONDS);

        assertEquals("artifact-value", second.finalSnapshot().variables().get("seen"));
    }

    /** 测试用偶发失败 Provider：首次流式调用返回错误终止块。 */
    private static final class FlakyProvider implements ModelProvider {

        /** 调用计数器。 */
        private final AtomicInteger calls;

        /** 创建偶发失败 Provider。 */
        private FlakyProvider(AtomicInteger calls) {
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
                    Map.of("error", "boom"),
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
