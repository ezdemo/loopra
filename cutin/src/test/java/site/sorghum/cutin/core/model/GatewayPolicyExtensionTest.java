package site.sorghum.cutin.core.model;

import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;
import site.sorghum.cutin.core.context.DefaultLoopContext;
import site.sorghum.cutin.core.context.Message;
import site.sorghum.cutin.core.context.Usage;
import site.sorghum.cutin.core.loop.DefaultLoopEngine;
import site.sorghum.cutin.core.loop.InterceptDecision;
import site.sorghum.cutin.core.loop.InterceptPoint;
import site.sorghum.cutin.core.loop.LoopHandle;
import site.sorghum.cutin.core.loop.LoopProgram;
import site.sorghum.cutin.core.loop.LoopResult;
import site.sorghum.cutin.core.loop.NodeType;
import site.sorghum.cutin.core.loop.Steps;
import site.sorghum.cutin.core.tool.ToolCall;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * 模型网关扩展测试：验证拦截器可以替换请求、响应、流增量与工具调用。
 */
class GatewayPolicyExtensionTest {

    /** BEFORE_MODEL 与 AFTER_MODEL 应能分别替换请求与响应。 */
    @Test
    void beforeAndAfterModelCanReplaceRequestAndResponse() throws Exception {
        DefaultLoopEngine engine = new DefaultLoopEngine();
        CapturingProvider provider = new CapturingProvider();
        engine.addModelProvider(provider);
        engine.addInterceptor(InterceptPoint.BEFORE_MODEL, 0, context -> InterceptDecision.modified(
            context.context(),
            new ModelCallRequest(
                "fake",
                List.of(new Message("system", "injected")),
                List.of(),
                Map.of()
            )
        ));
        engine.addInterceptor(InterceptPoint.AFTER_MODEL, 0, context -> InterceptDecision.modified(
            context.context(),
            ModelResponse.of(new Message("assistant", "replaced"), Usage.ZERO)
        ));

        LoopProgram program = LoopProgram.builder("replace-model")
            .node("model", NodeType.MODEL, Steps.modelFromContext("fake"))
            .node("finish", NodeType.OUTPUT, Steps.finish())
            .build();
        LoopHandle handle = engine.run(program, Map.of());
        LoopResult result = handle.result().get(5, TimeUnit.SECONDS);

        assertEquals(LoopResult.Status.COMPLETED, result.status());
        assertEquals(List.of(new Message("system", "injected")), provider.lastRequest.get().messages());
        assertEquals("replaced", result.finalSnapshot().messages().get(0).content());
    }

    /** ON_MODEL_STREAM 应能逐块替换流内容。 */
    @Test
    void modelStreamAndToolCallPayloadsCanBeReplaced() throws Exception {
        DefaultLoopEngine engine = new DefaultLoopEngine();
        engine.addModelProvider(new StreamingProvider());
        engine.addInterceptor(
            InterceptPoint.ON_MODEL_STREAM,
            0,
            context -> {
                if (!(context.payload() instanceof StreamChunk chunk)) {
                    return InterceptDecision.pass();
                }
                return InterceptDecision.replace(chunk.withContent(chunk.content().toUpperCase()));
            }
        );

        LoopProgram program = LoopProgram.builder("replace-stream")
            .node("model", NodeType.MODEL, Steps.streamModelFromContext("fake"))
            .node("finish", NodeType.OUTPUT, Steps.finish())
            .build();
        LoopHandle handle = engine.run(program, Map.of());
        LoopResult result = handle.result().get(5, TimeUnit.SECONDS);

        assertEquals(LoopResult.Status.COMPLETED, result.status());
        assertEquals("AB", result.finalSnapshot().messages().get(0).content());
    }

    /** Provider 终止块中的工具调用不应被网关再次合成导致重复。 */
    @Test
    void providerTerminalChunkToolCallsAreNotDuplicatedByGateway() {
        DefaultLoopEngine engine = new DefaultLoopEngine();
        engine.addModelProvider(new TerminalToolCallProvider());
        DefaultLoopContext context = engine.newContext("gateway-tool-calls", Map.of());
        ModelCallRequest request = new ModelCallRequest(
            "fake",
            List.of(new Message("user", "hi")),
            List.of(),
            Map.of()
        );

        List<ToolCall> calls;
        try (Stream<StreamChunk> chunks = context.models().stream(request, context)) {
            calls = chunks.flatMap(chunk -> chunk.toolCalls().stream()).toList();
        }

        assertEquals(1, calls.size(), () -> "tool calls=" + calls);
        assertEquals("read", calls.get(0).toolId());
    }

    /** 测试用捕获请求的 Provider。 */
    private static final class CapturingProvider implements ModelProvider {

        /** 最近一次收到的请求。 */
        private final AtomicReference<ModelCallRequest> lastRequest = new AtomicReference<>();

        @Override
        public String id() {
            return "fake";
        }

        @Override
        public ModelResponse call(ModelCallRequest request) {
            lastRequest.set(request);
            return ModelResponse.of(new Message("assistant", "ok"), Usage.ZERO);
        }

        @Override
        public Stream<StreamChunk> stream(ModelCallRequest request) {
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

    private static final class StreamingProvider implements ModelProvider {

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

    private static final class TerminalToolCallProvider implements ModelProvider {

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
            ToolCall call = new ToolCall("call_1", "read", Map.of("path", "a.txt"), "call_1");
            return Stream.of(new StreamChunk(
                "ok",
                null,
                List.of(call),
                List.of(),
                Usage.ZERO,
                Map.of(),
                true
            ));
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
