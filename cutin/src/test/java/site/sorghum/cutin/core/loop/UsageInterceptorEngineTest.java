package site.sorghum.cutin.core.loop;

import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;
import site.sorghum.cutin.core.context.DefaultLoopContext;
import site.sorghum.cutin.core.context.Message;
import site.sorghum.cutin.core.context.Usage;
import site.sorghum.cutin.core.model.ModelCallRequest;
import site.sorghum.cutin.core.model.ModelCapabilities;
import site.sorghum.cutin.core.model.ModelProvider;
import site.sorghum.cutin.core.model.ModelResponse;
import site.sorghum.cutin.core.model.StreamChunk;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * 用量拦截测试：模型 Step 产生用量后，AFTER_STEP 拦截器应能看到累计用量。
 */
class UsageInterceptorEngineTest {

    /** AFTER_STEP 拦截器应收到模型步骤产生的累计用量。 */
    @Test
    void interceptorsReceiveUsageAfterStepAddsIt() {
        DefaultLoopEngine engine = new DefaultLoopEngine();
        engine.addModelProvider(new UsageModelProvider());
        List<Usage> collected = new CopyOnWriteArrayList<>();
        engine.addInterceptor(InterceptPoint.AFTER_STEP, 1000, context -> {
            if (context.node() == null || context.node().type() != NodeType.MODEL) {
                return InterceptDecision.pass();
            }
            collected.add(context.context().usage());
            return InterceptDecision.pass();
        });

        LoopProgram program = LoopProgram.builder("usage")
            .node("model", NodeType.MODEL, Steps.modelFromContext("fake"))
            .node("out", NodeType.OUTPUT, Steps.finish())
            .build();
        DefaultLoopContext context = engine.newContext("ctx", Map.of());

        LoopResult result = engine.run(program, context).result().join();

        assertEquals(LoopResult.Status.COMPLETED, result.status());
        assertEquals(1, collected.size());
        assertEquals(30L, collected.get(0).totalTokens());
    }

    private static final class UsageModelProvider implements ModelProvider {

        @Override
        public String id() {
            return "fake";
        }

        @Override
        public ModelResponse call(ModelCallRequest request) {
            return new ModelResponse(
                new Message("assistant", "ok"),
                new Usage(10, 20, 0),
                true
            );
        }

        @Override
        public Stream<StreamChunk> stream(ModelCallRequest request) {
            return Stream.of(new StreamChunk("ok", new Usage(10, 20, 0)));
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
