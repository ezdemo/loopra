package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.loopra.bin.agent.core.AgentLoop;
import site.sorghum.loopra.bin.agent.core.LoopraAgent;
import site.sorghum.loopra.bin.agent.environment.SessionEnvironment;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.prompt.PromptPrefix;
import site.sorghum.loopra.bin.config.LoopraConfig;
import site.sorghum.loopra.bin.model.LoopraModelProvider;
import site.sorghum.loopra.bin.model.TestLoopraProvider;
import site.sorghum.loopra.bin.session.JsonlSessionStore;
import site.sorghum.loopra.bin.tool.ToolRegistry;
import site.sorghum.loopra.bin.tool.ToolSystemInitializer.ToolSystem;
import site.sorghum.loopra.tool.AgentOutput;

import java.io.IOException;
import java.lang.reflect.Field;
import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

class SessionTurnTest {

    @TempDir Path home;
    private String previousHome;
    private String previousLogSession;
    private LoopraAgent agent;
    private FailingStore store;
    private final SessionAgentRegistry sessions = new SessionAgentRegistry(5, (key, value) -> { });
    private String key;

    @BeforeEach
    void createAgent() {
        previousHome = System.getProperty("user.home");
        previousLogSession = LoopraModelProvider.CURRENT_LOG_SESSION.get();
        System.setProperty("user.home", home.toString());
        LoopraModelProvider.CURRENT_LOG_SESSION.remove();
        Path workspace = home.resolve("project");
        key = workspace + "::session";
        ToolRegistry tools = new ToolRegistry().setDisabledTools(Set.of());
        tools.setEnvironment(SessionEnvironment.local(workspace));
        store = new FailingStore(home.resolve("sessions"));
        agent = LoopraAgent.builder()
                .config(LoopraConfig.load())
                .environment(SessionEnvironment.local(workspace))
                .modelProvider(TestLoopraProvider.returning("done"))
                .sessionStore(store)
                .toolSystem(new ToolSystem(tools, new PromptPrefix("test", tools.toOpenAiTools())))
                .buildLightweight();
        agent.bindSession("session");
        store.calls.clear();
    }

    @AfterEach
    void releaseAgent() {
        store.failRewrite = store.failFlush = store.failSave = false;
        agent.dispose();
        store.shutdown();
        System.setProperty("user.home", previousHome);
        if (previousLogSession == null) LoopraModelProvider.CURRENT_LOG_SESSION.remove();
        else LoopraModelProvider.CURRENT_LOG_SESSION.set(previousLogSession);
    }

    @Test
    void recordsOnlyThisTurnsAssistantTimingAndRestoresOutputBeforeUnlock() throws Exception {
        ChatMessage old = ChatMessage.assistant("previous", null, null);
        old.setElapsedMs(123L);
        agent.getCtx().injectHistory(old);
        AtomicInteger completed = new AtomicInteger();
        try (SessionTurn turn = new SessionTurn(sessions, key, () -> {
            assertFalse(sessions.getLock(key).isLocked());
            assertNull(LoopraModelProvider.CURRENT_LOG_SESSION.get());
            completed.incrementAndGet();
        })) {
            turn.bind(agent, AgentOutput.NOOP);
            turn.beforeChat();
            agent.getCtx().injectHistory(ChatMessage.ofUser("question"));
            agent.getCtx().injectHistory(ChatMessage.assistant("answer", null, null));
        }

        assertEquals(123L, old.getElapsedMs());
        ChatMessage answer = agent.getCtx().getHistory().get(2);
        assertNotNull(answer.getTurnStartedAt());
        assertEquals(answer.getTurnFinishedAt() - answer.getTurnStartedAt(), answer.getElapsedMs());
        assertNull(agent.getCtx().getHistory().get(1).getElapsedMs());
        assertEquals(answer.getElapsedMs(), store.load().get(2).getElapsedMs());
        assertTrue(store.calls.contains("save"));
        assertSame(AgentOutput.NOOP, loop().getOutput());
        assertEquals(1, completed.get());
    }

    @Test
    void persistenceFailuresCannotSkipLaterCleanupOrLeaveSessionLocked() {
        SessionTurn turn = new SessionTurn(sessions, key, () -> {
            assertFalse(sessions.getLock(key).isLocked());
            store.calls.add("afterUnlock");
        });
        turn.bind(agent, AgentOutput.NOOP);
        turn.beforeChat();
        agent.getCtx().injectHistory(ChatMessage.assistant("answer", null, null));
        store.failRewrite = store.failFlush = store.failSave = true;

        RuntimeException failure = assertThrows(RuntimeException.class, turn::close);

        assertEquals("rewrite failed", failure.getMessage());
        assertEquals(List.of("flush failed", "save failed"),
                java.util.Arrays.stream(failure.getSuppressed()).map(Throwable::getMessage).toList());
        assertEquals(List.of("rewrite", "flush", "save", "afterUnlock"), store.calls);
        assertNull(LoopraModelProvider.CURRENT_LOG_SESSION.get());
        assertFalse(sessions.getLock(key).isLocked());
        assertDoesNotThrow(turn::close, "closing again must not persist or unlock twice");
    }

    @Test
    void cleanupFailureDoesNotReplaceTheExecutionFailure() {
        IllegalArgumentException executionFailure = new IllegalArgumentException("execution failed");
        RuntimeException received = assertThrows(RuntimeException.class, () -> {
            try (SessionTurn turn = new SessionTurn(sessions, key, () -> { })) {
                turn.bind(agent, AgentOutput.NOOP);
                store.failFlush = true;
                throw executionFailure;
            }
        });

        assertSame(executionFailure, received);
        assertEquals("flush failed", received.getSuppressed()[0].getMessage());
        assertTrue(store.calls.contains("save"));
        assertFalse(sessions.getLock(key).isLocked());
    }

    @Test
    void failureBeforeBindingAnAgentRestoresCallerContextAndReleasesLock() {
        LoopraModelProvider.CURRENT_LOG_SESSION.set("caller");
        AtomicInteger callbacks = new AtomicInteger();
        assertThrows(IllegalStateException.class, () -> {
            try (SessionTurn turn = new SessionTurn(sessions, key, callbacks::incrementAndGet)) {
                assertEquals("session", LoopraModelProvider.CURRENT_LOG_SESSION.get());
                throw new IllegalStateException("creation failed");
            }
        });

        assertEquals("caller", LoopraModelProvider.CURRENT_LOG_SESSION.get());
        assertFalse(sessions.getLock(key).isLocked());
        assertTrue(store.calls.isEmpty());
        assertEquals(1, callbacks.get());
    }

    @Test
    void sameSessionWaitsWhileAnotherSessionCanRun() throws Exception {
        var executor = Executors.newFixedThreadPool(2);
        CountDownLatch attempting = new CountDownLatch(1);
        SessionTurn first = new SessionTurn(sessions, key, () -> { });
        try {
            var same = executor.submit(() -> {
                attempting.countDown();
                try (SessionTurn ignored = new SessionTurn(sessions, key, () -> { })) { return "same"; }
            });
            assertTrue(attempting.await(5, TimeUnit.SECONDS));
            assertThrows(TimeoutException.class, () -> same.get(100, TimeUnit.MILLISECONDS));
            var different = executor.submit(() -> {
                try (SessionTurn ignored = new SessionTurn(sessions, key + "-other", () -> { })) { return "other"; }
            });
            assertEquals("other", different.get(5, TimeUnit.SECONDS));
            first.close();
            assertEquals("same", same.get(5, TimeUnit.SECONDS));
        } finally {
            first.close();
            executor.shutdownNow();
            assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS));
        }
    }

    @Test
    void failedAfterUnlockCallbackCannotLeakALockOrLoggingContext() {
        SessionTurn turn = new SessionTurn(sessions, key, () -> { throw new IllegalStateException("reload failed"); });
        assertEquals("reload failed", assertThrows(IllegalStateException.class, turn::close).getMessage());
        assertFalse(sessions.getLock(key).isLocked());
        assertNull(LoopraModelProvider.CURRENT_LOG_SESSION.get());
    }

    private AgentLoop loop() throws Exception {
        Field field = LoopraAgent.class.getDeclaredField("loop");
        field.setAccessible(true);
        return (AgentLoop) field.get(agent);
    }

    private static final class FailingStore extends JsonlSessionStore {
        private final java.util.ArrayList<String> calls = new java.util.ArrayList<>();
        private boolean failRewrite;
        private boolean failFlush;
        private boolean failSave;

        FailingStore(Path path) { super(path); }

        @Override
        public void rewrite(List<ChatMessage> messages) throws IOException {
            calls.add("rewrite");
            if (failRewrite) throw new IllegalStateException("rewrite failed");
            super.rewrite(messages);
        }

        @Override
        public void flush() {
            // JsonlSessionStore's constructor can call flush before this subclass is initialized.
            if (calls != null) calls.add("flush");
            if (failFlush) throw new IllegalStateException("flush failed");
            super.flush();
        }

        @Override
        public void saveUsage(String name, long prompt, long completion, long hit, long miss, long lastPrompt)
                throws IOException {
            calls.add("save");
            if (failSave) throw new IllegalStateException("save failed");
            super.saveUsage(name, prompt, completion, hit, miss, lastPrompt);
        }
    }
}
