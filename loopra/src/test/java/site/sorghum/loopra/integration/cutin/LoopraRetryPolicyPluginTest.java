package site.sorghum.loopra.integration.cutin;

import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;
import site.sorghum.cutin.core.context.Message;
import site.sorghum.cutin.core.context.Usage;
import site.sorghum.cutin.core.loop.DefaultLoopEngine;
import site.sorghum.cutin.core.loop.LoopProgram;
import site.sorghum.cutin.core.loop.LoopResult;
import site.sorghum.cutin.core.loop.NodeType;
import site.sorghum.cutin.core.loop.Steps;
import site.sorghum.cutin.core.model.ModelCallRequest;
import site.sorghum.cutin.core.model.ModelCapabilities;
import site.sorghum.cutin.core.model.ModelProvider;
import site.sorghum.cutin.core.model.ModelResponse;
import site.sorghum.cutin.core.model.StreamChunk;
import site.sorghum.cutin.core.plugin.PluginBeanManager;
import site.sorghum.loopra.integration.cutin.plugin.retry.LoopraRetryHost;
import site.sorghum.loopra.integration.cutin.plugin.retry.LoopraRetryPolicyPlugin;
import site.sorghum.loopra.tool.AgentOutput;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.Spliterator;
import java.util.Spliterators;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;
import java.util.stream.StreamSupport;

import static org.junit.jupiter.api.Assertions.assertEquals;

class LoopraRetryPolicyPluginTest {

    @Test
    void transientModelErrorIsRetriedThroughPluginBackoff() throws Exception {
        DefaultLoopEngine engine = new DefaultLoopEngine();
        AtomicInteger calls = new AtomicInteger();
        engine.addModelProvider(new FlakyProvider(calls));
        RetryStub host = new RetryStub();
        PluginBeanManager manager = new PluginBeanManager(engine.registrar());
        manager.registerPlugin(new LoopraRetryPolicyPlugin(host));
        manager.startAll();

        LoopProgram program = LoopProgram.builder("retry-policy")
            .node("model", NodeType.MODEL, Steps.streamModelFromContext("fake"))
            .node("finish", NodeType.OUTPUT, Steps.finish())
            .build();

        LoopResult result = engine.run(program, Map.of())
            .result()
            .get(5, TimeUnit.SECONDS);

        assertEquals(LoopResult.Status.COMPLETED, result.status(), result.message());
        assertEquals(2, calls.get());
        assertEquals(1, host.logs.get());
        assertEquals(0, result.finalSnapshot().variables().get("loopraModelRetryAttempts"));
    }

    @Test
    void closedIOExceptionAfterPartialStreamIsRetried() throws Exception {
        DefaultLoopEngine engine = new DefaultLoopEngine();
        AtomicInteger calls = new AtomicInteger();
        engine.addModelProvider(new HasNextFailureProvider(calls));
        RetryStub host = new RetryStub();
        PluginBeanManager manager = new PluginBeanManager(engine.registrar());
        manager.registerPlugin(new LoopraRetryPolicyPlugin(host));
        manager.startAll();

        LoopProgram program = LoopProgram.builder("retry-closed-stream")
            .node("model", NodeType.MODEL, Steps.streamModelFromContext("fake"))
            .node("finish", NodeType.OUTPUT, Steps.finish())
            .build();

        LoopResult result = engine.run(program, Map.of())
            .result()
            .get(5, TimeUnit.SECONDS);

        assertEquals(LoopResult.Status.COMPLETED, result.status(), result.message());
        assertEquals(2, calls.get());
        assertEquals(1, host.logs.get());
        assertEquals(0, result.finalSnapshot().variables().get("loopraModelRetryAttempts"));
    }

    private static final class RetryStub implements LoopraRetryHost {

        private final AtomicInteger logs = new AtomicInteger();

        @Override
        public AgentOutput getOutput() {
            return new AgentOutput() {
                @Override
                public void onContentDelta(String token) {
                }

                @Override
                public void onContentComplete() {
                }

                @Override
                public void onReasoningDelta(String token) {
                }

                @Override
                public void onReasoning(String reasoning) {
                }

                @Override
                public void onToolCall(String name, String args) {
                }

                @Override
                public void onToolResult(String name, String result) {
                }

                @Override
                public void onUsage(int promptTokens, int completionTokens, int totalTokens,
                                    int cacheHit, int cacheMiss) {
                }

                @Override
                public void onError(String error) {
                }

                @Override
                public void onLog(site.sorghum.loopra.tool.LogLevel level, String message) {
                    logs.incrementAndGet();
                }

                @Override
                public void onChoice(java.util.List<site.sorghum.loopra.tool.ChoiceOption> options) {
                }
            };
        }

        @Override
        public int modelRetryDelaySeconds(int attempt) {
            return 0;
        }
    }

    private static final class FlakyProvider implements ModelProvider {

        private final AtomicInteger calls;

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
                    Map.of("error", "{\"error\":{\"code\":500,\"message\":\"The model produced output that does not match the expected peg-native format\",\"type\":\"server_error\"}}"),
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

    private static final class HasNextFailureProvider implements ModelProvider {

        private final AtomicInteger calls;

        private HasNextFailureProvider(AtomicInteger calls) {
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
                Spliterator<StreamChunk> failing = new Spliterators.AbstractSpliterator<>(
                    2, Spliterator.ORDERED
                ) {
                    private boolean emitted;

                    @Override
                    public boolean tryAdvance(java.util.function.Consumer<? super StreamChunk> action) {
                        if (!emitted) {
                            emitted = true;
                            action.accept(new StreamChunk("partial", Usage.ZERO));
                            return true;
                        }
                        throw new RuntimeException("closed", new java.io.IOException("closed"));
                    }
                };
                return StreamSupport.stream(failing, false);
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
