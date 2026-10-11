package site.sorghum.cutin.core.model;

import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;
import site.sorghum.cutin.core.context.Message;
import site.sorghum.cutin.core.context.Usage;
import site.sorghum.cutin.core.loop.DefaultLoopEngine;
import site.sorghum.cutin.core.loop.LoopHandle;
import site.sorghum.cutin.core.loop.LoopProgram;
import site.sorghum.cutin.core.loop.LoopResult;
import site.sorghum.cutin.core.loop.NodeType;
import site.sorghum.cutin.core.loop.Steps;

import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 模型故障切换测试：同一模型 id 注册多个 Provider 时，失败后应回退到下一个。
 */
class ModelFallbackTest {

    /** 首个 Provider 抛错时，应自动切换到同模型的下一个可用 Provider。 */
    @Test
    void fallsBackToNextProviderForSameModel() throws Exception {
        DefaultLoopEngine engine = new DefaultLoopEngine();
        WorkingProvider working = new WorkingProvider();
        engine.addModelProvider(new FailingProvider());
        engine.addModelProvider(working);

        LoopProgram program = LoopProgram.builder("fallback")
            .node("model", NodeType.MODEL, Steps.model("shared", "prompt"))
            .node("finish", NodeType.OUTPUT, Steps.finish())
            .build();

        LoopHandle handle = engine.run(program, Map.of("prompt", "hello"));
        LoopResult result = handle.result().get(5, TimeUnit.SECONDS);

        assertEquals(LoopResult.Status.COMPLETED, result.status());
        assertTrue(working.called);
    }

    static class FailingProvider implements ModelProvider {

        @Override
        public String id() {
            return "failing";
        }

        @Override
        public ModelResponse call(ModelCallRequest request) {
            throw new IllegalStateException("provider down");
        }

        @Override
        public Stream<StreamChunk> stream(ModelCallRequest request) {
            throw new IllegalStateException("provider down");
        }

        @Override
        public ModelCapabilities capabilities() {
            return new ModelCapabilities(Set.of("shared"), true, true);
        }

        @Override
        public ONode buildBody(ModelCallRequest request, boolean stream) {
            return null;
        }
    }

    static class WorkingProvider implements ModelProvider {

        private volatile boolean called;

        @Override
        public String id() {
            return "working";
        }

        @Override
        public ModelResponse call(ModelCallRequest request) {
            called = true;
            return ModelResponse.of(new Message("assistant", "ok"), new Usage(1, 1, 0));
        }

        @Override
        public Stream<StreamChunk> stream(ModelCallRequest request) {
            called = true;
            return Stream.of(new StreamChunk("ok", Usage.ZERO));
        }

        @Override
        public ModelCapabilities capabilities() {
            return new ModelCapabilities(Set.of("shared"), true, true);
        }

        @Override
        public ONode buildBody(ModelCallRequest request, boolean stream) {
            return null;
        }
    }
}
