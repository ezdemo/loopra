package site.sorghum.cutin.core.model;

import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;
import site.sorghum.cutin.core.context.Message;
import site.sorghum.cutin.core.context.Usage;
import site.sorghum.cutin.core.event.InMemoryEventLog;
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
 * 流式模型 Step 测试：验证流式增量拼接与模型流事件。
 */
class StreamModelStepTest {

    /** 流式模型节点应拼接全部增量并发布 ON_MODEL_STREAM 事件。 */
    @Test
    void streamsChunksAndEmitsModelStreamEvents() throws Exception {
        DefaultLoopEngine engine = new DefaultLoopEngine();
        engine.addModelProvider(new StreamingProvider());
        InMemoryEventLog log = new InMemoryEventLog();
        engine.addEventHandler(log);

        LoopProgram program = LoopProgram.builder("stream")
            .node("model", NodeType.MODEL, Steps.streamModelFromContext("fake"))
            .node("finish", NodeType.OUTPUT, Steps.finish())
            .build();

        LoopHandle handle = engine.run(program, Map.of());
        LoopResult result = handle.result().get(5, TimeUnit.SECONDS);

        assertEquals(LoopResult.Status.COMPLETED, result.status());
        assertTrue(result.finalSnapshot().messages().stream()
            .anyMatch(message -> message.role().equals("assistant") && message.content().equals("ab")));
        assertTrue(log.events().stream().anyMatch(event -> event.type().equals("ON_MODEL_STREAM")));
    }

    static class StreamingProvider implements ModelProvider {

        @Override
        public String id() {
            return "fake";
        }

        @Override
        public ModelResponse call(ModelCallRequest request) {
            return ModelResponse.of(new Message("assistant", "ab"), Usage.ZERO);
        }

        @Override
        public Stream<StreamChunk> stream(ModelCallRequest request) {
            return Stream.of(new StreamChunk("a", Usage.ZERO), new StreamChunk("b", Usage.ZERO));
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
