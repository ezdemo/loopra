package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.noear.solon.core.handle.ContextEmpty;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.bin.session.JsonlSessionStore;
import site.sorghum.loopra.bin.session.SessionStore;
import site.sorghum.loopra.tool.AgentOutput;

import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

@Timeout(25)
class ExternalAcpSessionsTest {
    @TempDir Path home;

    private ExternalAcpSessions runtime() {
        return new ExternalAcpSessions(cwd -> new AcpProcessTransport(List.of(
                Path.of(System.getProperty("java.home"), "bin", "java").toString(), "-Duser.home=" + home,
                "-cp", System.getProperty("surefire.test.class.path", System.getProperty("java.class.path")),
                FakeAcpProcess.class.getName()), Map.of(), cwd));
    }
    private JsonlSessionStore store() throws Exception {
        JsonlSessionStore store = new JsonlSessionStore(home.resolve("sessions"));
        store.setAcpBinding("chat", new SessionStore.AcpBinding("claude-code", null, null));
        return store;
    }

    @Test void preservesConnectionAndRestoresRemoteSessionWithoutDuplicateReplay() throws Exception {
        var store = store();
        try {
            try (var runtime = runtime()) {
                prompt(runtime, store, "one", AgentOutput.NOOP);
                prompt(runtime, store, "two", AgentOutput.NOOP);
            }
            assertEquals("fake-session", store.getAcpBinding("chat").remoteSessionId());
            try (var runtime = runtime()) { prompt(runtime, store, "three", AgentOutput.NOOP); }
            var history = store.load("chat");
            assertEquals(6, history.size());
            assertEquals(List.of("one", "reply:one", "two", "reply:two", "three", "reply:three"),
                    history.stream().map(message -> message.getContent()).toList());
        } finally { store.shutdown(); }
    }

    @Test void groupedConfigurationChangesPersistAcrossConnectionsAndDriveActualPrompts() throws Exception {
        var store = store();
        try {
            try (var runtime = runtime()) {
                var initial = runtime.configuration("key", home, "chat", store, null, null);
                assertEquals(2, initial.size(), "Unknown future option variants must be ignored");
                assertEquals("Custom models", initial.get(0).options().get(0).group());
                assertThrows(RuntimeException.class, () -> runtime.configuration("key", home, "chat", store, "model", "unadvertised"));
                runtime.configuration("key", home, "chat", store, "model", "beta");
                runtime.configuration("key", home, "chat", store, "mode", "plan");
                assertThrows(RuntimeException.class, () -> runtime.configuration("key", home, "chat", store, "mode", "fail"));
            }
            try (var runtime = runtime()) {
                var restored = runtime.configuration("key", home, "chat", store, null, null);
                assertEquals("beta", restored.get(0).currentValue());
                assertEquals("plan", restored.get(1).currentValue());
                prompt(runtime, store, "state", AgentOutput.NOOP);
                assertTrue(store.load("chat").stream().anyMatch(message -> "reply:state:beta:plan".equals(message.getContent())));
            }
        } finally { store.shutdown(); }
    }

    @Test void unavailableSavedConfigurationIsDroppedWhileValidChoicesSurvive() throws Exception {
        var store = store();
        try {
            store.setAgentConfig("chat", Map.of("mode", "\"plan\"", "model", "\"unadvertised\"", "future", "\"x\""));
            try (var runtime = runtime()) {
                var options = runtime.configuration("key", home, "chat", store, null, null);
                assertEquals("plan", options.get(1).currentValue());
                assertEquals(Map.of("mode", "\"plan\""), store.getAgentConfig("chat"));
                prompt(runtime, store, "state", AgentOutput.NOOP);
                assertTrue(store.load("chat").stream().anyMatch(message -> "reply:state:alpha:plan".equals(message.getContent())));
            }
        } finally { store.shutdown(); }
    }

    @Test void agentRejectedSavedValueIsDroppedWithoutBreakingOpen() throws Exception {
        var store = store();
        try {
            // "fail" is advertised by FakeAcpProcess but its set_config_option returns -32602.
            store.setAgentConfig("chat", Map.of("mode", "\"fail\""));
            try (var runtime = runtime()) {
                var options = runtime.configuration("key", home, "chat", store, null, null);
                assertEquals("default", options.get(1).currentValue());
                assertEquals(Map.of(), store.getAgentConfig("chat"));
                prompt(runtime, store, "after rejected config", AgentOutput.NOOP);
                assertTrue(store.load("chat").stream().anyMatch(message -> "reply:after rejected config".equals(message.getContent())));
            }
        } finally { store.shutdown(); }
    }

    @Test void permissionAllowDenyAndCancelCompleteTheOriginalPrompt() throws Exception {
        for (String selected : List.of("allow", "deny", "cancel")) {
            var store = store(); var active = new AtomicReference<AcpWorkbenchClient>();
            var ready = new CountDownLatch(1);
            ExecutorService executor = Executors.newSingleThreadExecutor();
            try (var runtime = runtime()) {
                AgentOutput output = new SseAgentOutput(new SseEmitter(new ContextEmpty())) {
                    @Override public void sendEvent(String type, String data) { if (type.equals("choice")) ready.countDown(); }
                };
                Future<?> task = executor.submit(() -> {
                    try { runtime.prompt("key", home, "chat", store, UserMessage.of("permission"), output, false,
                            null, List.of(), active::set, ignored -> {}); }
                    catch (Exception e) { throw new RuntimeException(e); }
                });
                assertTrue(ready.await(8, TimeUnit.SECONDS));
                assertFalse(task.isDone());
                if (selected.equals("cancel")) active.get().cancel();
                else {
                    String id = (String) active.get().pendingPermissions().get(0).get("permissionRequestId");
                    assertThrows(RuntimeException.class, () -> active.get().resolvePermission(id, "invalid"));
                    active.get().resolvePermission(id, selected);
                }
                task.get(8, TimeUnit.SECONDS);
                assertTrue(active.get().pendingPermissions().isEmpty());
                assertTrue(store.load("chat").stream().filter(message -> message.getToolCalls() != null)
                        .flatMap(message -> message.getToolCalls().stream())
                        .anyMatch(call -> String.valueOf(call.arguments()).contains("final arguments")));
            } finally { executor.shutdownNow(); store.shutdown(); }
        }
    }

    @Test void interruptingHttpTaskReleasesConnectionAndSessionLock() throws Exception {
        var store = store();
        CountDownLatch ready = new CountDownLatch(1), cleaned = new CountDownLatch(1);
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try (var runtime = runtime()) {
            AgentOutput output = new SseAgentOutput(new SseEmitter(new ContextEmpty())) {
                @Override public void sendEvent(String type, String data) { if (type.equals("choice")) ready.countDown(); }
            };
            Future<?> task = worker.submit(() -> {
                try { prompt(runtime, store, "permission", output); }
                catch (Exception ignored) { /* Simulates cancellation of the SSE worker. */ }
                finally { cleaned.countDown(); }
            });
            assertTrue(ready.await(8, TimeUnit.SECONDS));
            task.cancel(true);
            assertTrue(cleaned.await(8, TimeUnit.SECONDS));
            prompt(runtime, store, "after cancellation", AgentOutput.NOOP);
            assertTrue(store.load("chat").stream().anyMatch(message -> "reply:after cancellation".equals(message.getContent())));
        } finally { worker.shutdownNow(); store.shutdown(); }
    }

    @Test void processExitFailsPromptImmediatelyAndKeepsRecoveryIdentity() throws Exception {
        var store = store();
        try (var runtime = runtime()) {
            assertThrows(Exception.class, () -> prompt(runtime, store, "exit", AgentOutput.NOOP));
            assertEquals("fake-session", store.getAcpBinding("chat").remoteSessionId());
        } finally { store.shutdown(); }
    }
    @Test void agentOriginatedConfigurationChangeSurvivesReconnect() throws Exception {
        var store = store();
        try {
            try (var runtime = runtime()) {
                // The Agent changes its own permission mode and reports it via config_option_update.
                prompt(runtime, store, "agent-switch", AgentOutput.NOOP);
                assertEquals("\"plan\"", store.getAgentConfig("chat").get("mode"));
            }
            try (var runtime = runtime()) {
                var restored = runtime.configuration("key", home, "chat", store, null, null);
                assertEquals("plan", restored.get(1).currentValue());
                prompt(runtime, store, "state", AgentOutput.NOOP);
                assertTrue(store.load("chat").stream().anyMatch(message -> "reply:state:alpha:plan".equals(message.getContent())));
            }
        } finally { store.shutdown(); }
    }

    @Test void linkedProjectContextAndDirectoriesReachTheAgentWithoutPollutingHistory() throws Exception {
        var store = store();
        String linked = home.resolve("linked-project").toString();
        String context = "本轮关联项目：linked-project\n根目录：" + linked;
        try (var runtime = runtime()) {
            // The workbench usually reads configuration first, which opens a session without
            // linked directories. The first prompt must still bind them.
            runtime.configuration("key", home, "chat", store, null, null);
            prompt(runtime, store, "echo-linked", AgentOutput.NOOP, context, List.of(linked));
            assertTrue(store.load("chat").stream().anyMatch(message -> ("reply-linked:true:" + linked).equals(message.getContent())));
            // The workbench transcript keeps the user's original text, not the injected context.
            assertEquals("echo-linked", store.load("chat").get(0).getContent());
        } finally { store.shutdown(); }
        // A restored session also receives the linked directories on session/load.
        try (var runtime = runtime()) {
            prompt(runtime, store, "echo-linked", AgentOutput.NOOP, context, List.of(linked));
            assertTrue(store.load("chat").stream().anyMatch(message -> ("reply-linked:true:" + linked).equals(message.getContent())));
        } finally { store.shutdown(); }
    }

    private void prompt(ExternalAcpSessions runtime, SessionStore store, String text, AgentOutput output) throws Exception {
        prompt(runtime, store, text, output, null, List.of());
    }

    private void prompt(ExternalAcpSessions runtime, SessionStore store, String text, AgentOutput output,
                        String linkedProjectContext, List<String> directories) throws Exception {
        runtime.prompt("key", home, "chat", store, UserMessage.of(text), output, false,
                linkedProjectContext, directories, ignored -> {}, ignored -> {});
    }
}
