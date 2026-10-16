package site.sorghum.loopra.bin.agent.core;

import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;
import site.sorghum.cutin.core.context.Usage;
import site.sorghum.loopra.bin.agent.listener.AgentLoopListener;
import site.sorghum.loopra.bin.agent.listener.NoOpAgentLoopListener;
import site.sorghum.loopra.tool.AgentOutput;
import site.sorghum.loopra.tool.ChoiceOption;
import site.sorghum.loopra.tool.LogLevel;
import site.sorghum.loopra.tool.TokenSpeed;

import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class UsageReporterTest {

    @Test
    void tokenSpeedIsDeliveredToAnOutputWithoutAnyWebImplementation() {
        AtomicReference<TokenSpeed> received = new AtomicReference<>();
        var output = new TestOutput() {
            @Override
            public void onTokenSpeed(TokenSpeed speed) {
                received.set(speed);
            }
        };
        UsageReporter reporter = new UsageReporter(ignored -> { }, () -> null, () -> "model",
                () -> NoOpAgentLoopListener.INSTANCE, () -> output);
        reporter.emitTokenSpeed(20, 4, 3, true);

        assertEquals(new TokenSpeed(20, 4, 3, true), received.get());
    }

    @Test
    void defaultOutputKeepsExistingTokenSpeedWireFields() {
        AtomicReference<String> type = new AtomicReference<>();
        AtomicReference<String> json = new AtomicReference<>();
        var output = new TestOutput() {
            @Override
            public void sendEvent(String eventType, String data) {
                type.set(eventType);
                json.set(data);
            }
        };
        output.onTokenSpeed(new TokenSpeed(20, 4, 3, true));

        ONode event = ONode.ofJson(json.get());
        assertEquals("token_speed", type.get());
        assertEquals(20, event.get("completionTokens").getInt());
        assertEquals(4, event.get("tokensPerSecond").getDouble());
        assertEquals(3, event.get("avgTokensPerSecond").getDouble());
        assertTrue(event.get("done").getBoolean());
    }

    @Test
    void failingListenerCannotSuppressOutputOrPromptTokenTracking() {
        AtomicInteger prompt = new AtomicInteger();
        AtomicInteger persisted = new AtomicInteger();
        AtomicInteger delivered = new AtomicInteger();
        AgentLoopListener failingListener = new AgentLoopListener() {
            @Override
            public void onUsage(String model, int input, int output, int total, int hit, int miss) {
                throw new IllegalStateException("listener failed");
            }
        };
        var output = new TestOutput() {
            @Override
            public void onUsage(String model, int input, int output, int total, int hit, int miss) {
                delivered.set(total);
            }
        };
        UsageReporter reporter = new UsageReporter(prompt::set, () -> persisted::set,
                () -> "model", () -> failingListener, () -> output);
        reporter.reportCutinUsage(new Usage(10, 5, 0, 10, 0));

        assertEquals(10, prompt.get());
        assertEquals(10, persisted.get());
        assertEquals(15, delivered.get());
    }

    private static class TestOutput implements AgentOutput {
        @Override
        public void onContentDelta(String token) { }
        @Override
        public void onContentComplete() { }
        @Override
        public void onReasoningDelta(String token) { }
        @Override
        public void onReasoning(String reasoning) { }
        @Override
        public void onToolCall(String name, String args) { }
        @Override
        public void onToolResult(String name, String result) { }
        @Override
        public void onUsage(int prompt, int completion, int total, int hit, int miss) { }
        @Override
        public void onError(String error) { }
        @Override
        public void onLog(LogLevel level, String message) { }
        @Override
        public void onChoice(List<ChoiceOption> options) { }
    }
}
