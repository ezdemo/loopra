package site.sorghum.cutin.core.runtime;

import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;
import site.sorghum.cutin.core.context.LoopContext;
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
import site.sorghum.cutin.core.model.ModelCallRequest;
import site.sorghum.cutin.core.model.ModelCapabilities;
import site.sorghum.cutin.core.model.ModelProvider;
import site.sorghum.cutin.core.model.ModelResponse;
import site.sorghum.cutin.core.model.StreamChunk;
import site.sorghum.cutin.core.tool.Tool;
import site.sorghum.cutin.core.tool.ToolCall;
import site.sorghum.cutin.core.tool.ToolDefinition;
import site.sorghum.cutin.core.tool.ToolResult;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 模型与工具生命周期测试：验证模型、工具拦截点在一次运行中的执行顺序。
 */
class ModelAndToolLifecycleTest {

    /** 模型与工具的前置/后置拦截器应按预期顺序执行，并正常完成循环。 */
    @Test
    void modelAndToolLifecycleInterceptorsRunInOrder() throws Exception {
        DefaultLoopEngine engine = new DefaultLoopEngine();
        List<String> lifecycle = new CopyOnWriteArrayList<>();

        engine.addModelProvider(new FakeModelProvider());
        engine.addTool(new EchoTool());
        engine.addInterceptor(InterceptPoint.BEFORE_MODEL, 100, context -> {
            lifecycle.add("before-model");
            return InterceptDecision.pass();
        });
        engine.addInterceptor(InterceptPoint.AFTER_MODEL, 100, context -> {
            lifecycle.add("after-model");
            return InterceptDecision.pass();
        });
        engine.addInterceptor(InterceptPoint.BEFORE_TOOL, 100, context -> {
            lifecycle.add("before-tool");
            return InterceptDecision.pass();
        });
        engine.addInterceptor(InterceptPoint.AFTER_TOOL, 100, context -> {
            lifecycle.add("after-tool");
            return InterceptDecision.pass();
        });

        LoopProgram program = LoopProgram.builder("runtime")
            .node("model", NodeType.MODEL, Steps.model("fake", "prompt"))
            .node("tool", NodeType.TOOL, Steps.tool("echo", context -> Map.of("value", "x")))
            .node("finish", NodeType.OUTPUT, Steps.finish())
            .build();

        LoopHandle handle = engine.run(program, Map.of("prompt", "hello"));
        LoopResult result = handle.result().get(5, TimeUnit.SECONDS);

        assertEquals(LoopResult.Status.COMPLETED, result.status());
        assertTrue(result.finalSnapshot().messages().stream()
            .anyMatch(message -> "assistant".equals(message.role()) && "hello".equals(message.content())));
        assertTrue(result.finalSnapshot().variables().containsKey("lastToolResult"));
        assertTrue(lifecycle.indexOf("before-model") < lifecycle.indexOf("after-model"));
        assertTrue(lifecycle.indexOf("before-tool") < lifecycle.indexOf("after-tool"));
    }

    static class FakeModelProvider implements ModelProvider {

        @Override
        public String id() {
            return "fake";
        }

        @Override
        public ModelResponse call(ModelCallRequest request) {
            return ModelResponse.of(new Message("assistant", "hello"), new Usage(10, 5, 1));
        }

        @Override
        public Stream<StreamChunk> stream(ModelCallRequest request) {
            return Stream.of(new StreamChunk("hello", Usage.ZERO));
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

    static class EchoTool implements Tool {

        @Override
        public String id() {
            return "echo";
        }

        @Override
        public ToolDefinition definition() {
            return new ToolDefinition("echo", "echo arguments", Map.of());
        }

        @Override
        public ToolResult call(ToolCall call, LoopContext context) {
            return ToolResult.success(call.id(), call.arguments());
        }
    }
}
