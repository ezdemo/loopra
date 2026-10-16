package site.sorghum.loopra.bin.agent.core;

import org.junit.jupiter.api.Test;
import site.sorghum.loopra.bin.agent.spi.SessionUsageSink;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

class SessionLifecycleTest {

    @Test
    void lifecycleUsesCurrentSinkAndUpdatesAffinityWithoutAnAgentLoop() {
        List<String> events = new ArrayList<>();
        AtomicReference<String> affinity = new AtomicReference<>("old");
        AtomicReference<SessionUsageSink> currentSink = new AtomicReference<>();
        SessionLifecycle lifecycle = new SessionLifecycle(() -> events.add("begin"), () -> events.add("end"),
                currentSink::get, affinity::get, affinity::set);
        lifecycle.beginCutinLoop();
        lifecycle.beforeTurn("hello");
        assertEquals("old", lifecycle.sessionAffinity());

        currentSink.set(new SessionUsageSink() {
            @Override
            public void updateLastPromptTokens(int tokens) { }
            @Override
            public String beforeTurn(String message) {
                events.add(message);
                return "new";
            }
            @Override
            public void afterTurn() {
                events.add("persist");
            }
        });
        lifecycle.beforeTurn(" ");
        lifecycle.beforeTurn("hello");
        lifecycle.afterTurn();
        lifecycle.endCutinLoop();

        assertEquals("new", lifecycle.sessionAffinity());
        assertEquals(List.of("begin", "hello", "persist", "end"), events);
    }

    @Test
    void persistenceCallbackFailureDoesNotAbortTheLoop() {
        SessionUsageSink failing = new SessionUsageSink() {
            @Override
            public void updateLastPromptTokens(int tokens) { }
            @Override
            public String beforeTurn(String message) {
                throw new IllegalStateException("before turn failed");
            }
            @Override
            public void afterTurn() {
                throw new IllegalStateException("after turn failed");
            }
        };
        SessionLifecycle lifecycle = new SessionLifecycle(() -> { }, () -> { }, () -> failing,
                () -> "original", ignored -> fail("must not change affinity"));
        assertDoesNotThrow(() -> lifecycle.beforeTurn("hello"));
        assertDoesNotThrow(lifecycle::afterTurn);
        assertEquals("original", lifecycle.sessionAffinity());
    }
}
