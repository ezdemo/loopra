package site.sorghum.cutin.core.loop;

import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;
import site.sorghum.cutin.core.context.Message;
import site.sorghum.cutin.core.context.Usage;
import site.sorghum.cutin.core.model.ModelCallError;
import site.sorghum.cutin.core.model.ModelCallRequest;
import site.sorghum.cutin.core.model.ModelCapabilities;
import site.sorghum.cutin.core.model.ModelProvider;
import site.sorghum.cutin.core.model.ModelResponse;
import site.sorghum.cutin.core.model.StreamChunk;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * BEFORE_RETRY 拦截点测试：模型错误触发重试时，重试前钩子应执行。
 */
class BeforeRetryInterceptorTest {

    /** 模型流错误触发重试时，BEFORE_RETRY 应执行一次，最终正常完成。 */
    @Test
    void beforeRetryRunsWhenModelErrorIsRetried() throws Exception {
        DefaultLoopEngine engine = new DefaultLoopEngine();
        AtomicInteger calls = new AtomicInteger();
        AtomicInteger beforeRetries = new AtomicInteger();
        engine.addModelProvider(new FlakyProvider(calls));
        engine.addInterceptor(InterceptPoint.ON_MODEL_ERROR, 0, context -> {
            if (context.payload() instanceof ModelCallError error
                    && error.message() != null
                    && error.message().contains("HTTP 503")) {
                return InterceptDecision.retry("retry 503");
            }
            return InterceptDecision.pass();
        });
        engine.addInterceptor(InterceptPoint.BEFORE_RETRY, 0, context -> {
            beforeRetries.incrementAndGet();
            return InterceptDecision.pass();
        });

        LoopProgram program = LoopProgram.builder("before-retry")
            .node("model", NodeType.MODEL, Steps.streamModelFromContext("fake"))
            .node("finish", NodeType.OUTPUT, Steps.finish())
            .build();

        LoopResult result = engine.run(program, Map.of())
            .result()
            .get(5, TimeUnit.SECONDS);

        assertEquals(LoopResult.Status.COMPLETED, result.status());
        assertEquals(2, calls.get());
        assertEquals(1, beforeRetries.get());
        assertEquals("ok", result.finalSnapshot().messages().get(0).content());
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
            return ModelResponse.of(new Message("assistant", "ok"), Usage.ZERO);
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
                    Map.of("error", "HTTP 503"),
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
