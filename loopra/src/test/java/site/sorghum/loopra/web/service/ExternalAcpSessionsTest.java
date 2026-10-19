package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.noear.solon.core.handle.ContextEmpty;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.bin.session.JsonlSessionStore;
import site.sorghum.loopra.bin.session.SessionStore;
import site.sorghum.loopra.bin.session.SubAgentSessionStore;
import site.sorghum.loopra.tool.AgentOutput;
import site.sorghum.loopra.web.common.ServiceException;

import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

@Timeout(25)
class ExternalAcpSessionsTest {
    @TempDir Path home;

    private ExternalAcpSessions runtime() {
        return runtime(new String[0]);
    }
    private ExternalAcpSessions runtime(String... extraOptions) {
        List<String> command = new ArrayList<>(List.of(
                Path.of(System.getProperty("java.home"), "bin", "java").toString(), "-Duser.home=" + home));
        command.addAll(List.of(extraOptions));
        command.addAll(List.of("-cp", System.getProperty("surefire.test.class.path", System.getProperty("java.class.path")),
                FakeAcpProcess.class.getName()));
        return new ExternalAcpSessions(cwd -> new AcpProcessTransport(command, Map.of(), cwd));
    }
    private JsonlSessionStore store() throws Exception {
        JsonlSessionStore store = new JsonlSessionStore(home.resolve("sessions"));
        store.setAcpBinding("chat", new SessionStore.AcpBinding("claude-code", null, null));
        return store;
    }

    @Test void managedMcpIsSentOnNewLoadAndChangedConfigurationReconnects() throws Exception {
        Path config = home.resolve(".loopra/mcp-servers.json");
        java.nio.file.Files.createDirectories(config.getParent());
        java.nio.file.Files.writeString(config, "{\"servers\":[{\"name\":\"one\",\"type\":\"http\",\"url\":\"https://example.test/mcp\"}]}");
        var store = store();
        StringBuilder text = new StringBuilder();
        AgentOutput output = new SseAgentOutput(new SseEmitter(new ContextEmpty())) {
            @Override public void onContentDelta(String token) { text.append(token); }
        };
        try {
            try (var runtime = runtime()) {
                prompt(runtime, store, "echo-mcp", output);
                assertTrue(text.toString().startsWith("new:"));
                assertTrue(text.toString().contains("\"name\":\"one\""), text.toString());
                java.nio.file.Files.writeString(config, "{\"servers\":[{\"name\":\"two\",\"type\":\"stdio\",\"command\":\"node\",\"env\":{\"TEST\":\"value\"}}]}");
                text.setLength(0);
                prompt(runtime, store, "echo-mcp", output);
                assertTrue(text.toString().startsWith("load:"), text.toString());
                assertTrue(text.toString().contains("\"name\":\"two\""));
                assertFalse(text.toString().contains("\"name\":\"one\""));
            }
            text.setLength(0);
            try (var runtime = runtime()) { prompt(runtime, store, "echo-mcp", output); }
            assertTrue(text.toString().startsWith("load:"));
            assertTrue(text.toString().contains("\"name\":\"two\""));
        } finally { store.shutdown(); }
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

    @Test void acpDiffContentBecomesTheWorkbenchFileChangeSummary() throws Exception {
        var store = store();
        List<String> events = new ArrayList<>();
        AgentOutput output = new SseAgentOutput(new SseEmitter(new ContextEmpty())) {
            @Override public void sendEvent(String type, String data) { if (type.equals("file_changes")) events.add(data); }
        };
        try (var runtime = runtime()) {
            prompt(runtime, store, "edit", output);
            assertEquals(1, events.size(), "A completed edit must emit one file_changes summary");
            assertTrue(events.get(0).contains("\"path\":\"example.txt\""));
            assertTrue(events.get(0).contains("\"additions\":1"));
            assertTrue(events.get(0).contains("\"deletions\":1"));
            assertTrue(events.get(0).contains("\"created\":false"));
            assertTrue(store.load("chat").stream().anyMatch(message -> message.getFileChanges() != null
                    && message.getFileChanges().stream().anyMatch(change -> "example.txt".equals(change.path())
                    && change.additions() == 1 && change.deletions() == 1 && !change.created())));
        } finally { store.shutdown(); }
    }

    @Test void claudeSubagentTrafficIsReportedAsNestedWorkbenchEvents() throws Exception {
        var store = store();
        List<String> events = new ArrayList<>();
        Map<String, List<String>> payloads = new LinkedHashMap<>();
        StringBuilder rootText = new StringBuilder();
        AgentOutput output = new SseAgentOutput(new SseEmitter(new ContextEmpty())) {
            @Override public void sendEvent(String type, String data) {
                events.add(type);
                payloads.computeIfAbsent(type, ignored -> new ArrayList<>()).add(data);
            }
            @Override public void onContentDelta(String token) { rootText.append(token); }
        };
        try (var runtime = runtime()) {
            prompt(runtime, store, "agent", output);
        } finally { store.shutdown(); }

        assertTrue(events.containsAll(List.of("sub_start", "sub_content", "sub_reasoning",
                "sub_tool_call", "sub_tool_result", "sub_end")), events.toString());
        assertTrue(payloads.get("sub_start").get(0).contains("\"subId\":\"task-1\""));
        assertTrue(payloads.get("sub_start").get(0).contains("\"task\":\"Explore code\""));
        assertTrue(payloads.get("sub_content").stream().anyMatch(data -> data.contains("\"token\":\"child says \"")));
        assertTrue(payloads.get("sub_content").stream().anyMatch(data -> data.contains("\"token\":\"done.\"")));
        assertTrue(payloads.get("sub_reasoning").get(0).contains("\"token\":\"child thinks\""));
        assertTrue(payloads.get("sub_tool_call").get(0).contains("\"subId\":\"task-1\""));
        assertTrue(payloads.get("sub_tool_call").get(0).contains("\"toolCallId\":\"child-1\""));
        assertTrue(payloads.get("sub_tool_call").get(0).contains("\"name\":\"Read\""));
        assertTrue(payloads.get("sub_tool_result").get(0).contains("\"toolCallId\":\"child-1\""));
        assertTrue(payloads.get("sub_tool_result").get(0).contains("\"status\":\"completed\""));
        assertTrue(payloads.get("sub_end").get(0).contains("\"subId\":\"task-1\""));
        assertEquals("", rootText.toString(), "Subagent text must not leak into the root transcript");
        assertTrue(events.indexOf("sub_start") < events.indexOf("sub_end"));

        // The right-hand replay panel reads the sub-agent store, not the live stream.
        var subStore = new SubAgentSessionStore(home.resolve("sessions"));
        var listed = subStore.list("chat");
        assertEquals(1, listed.size(), "Claude subagent run must be listable in the replay panel");
        assertEquals("Explore code", listed.get(0).task());
        assertEquals("Explore", listed.get(0).name());
        assertEquals("completed", listed.get(0).status());
        var recorded = subStore.events("chat", "task-1");
        assertEquals("sub_start", recorded.get(0).get("type"));
        assertEquals("sub_end", recorded.get(recorded.size() - 1).get("type"));
        assertEquals("completed", recorded.get(recorded.size() - 1).get("status"));
        assertTrue(recorded.stream().anyMatch(event -> "sub_content".equals(event.get("type"))
                && String.valueOf(event.get("token")).contains("child says")));
        assertTrue(recorded.stream().anyMatch(event -> "sub_tool_call".equals(event.get("type"))
                && "child-1".equals(event.get("toolCallId"))));
    }

    @Test void contextUsageReportedByTheAgentIsPersistedAndStreamed() throws Exception {
        var store = store();
        List<String> events = new ArrayList<>();
        AgentOutput output = new SseAgentOutput(new SseEmitter(new ContextEmpty())) {
            @Override public void sendEvent(String type, String data) { if (type.equals("usage")) events.add(data); }
        };
        try (var runtime = runtime()) {
            prompt(runtime, store, "one", output);
            SessionStore.AcpUsage usage = store.getAcpUsage("chat");
            assertNotNull(usage, "ACP usage_update must outlive the transient connection");
            assertEquals(3210, usage.used());
            assertEquals(200000, usage.size());
            assertEquals(0.0456, usage.cost(), 1e-9);
            assertEquals("USD", usage.currency());
            assertEquals("claude-test", usage.model());
            assertEquals(1, events.size());
            assertTrue(events.get(0).contains("\"used\":3210"));
            assertTrue(events.get(0).contains("\"size\":200000"));
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

    @Test void promptWaitsForAnInFlightConfigurationInsteadOfReportingARunningTurn() throws Exception {
        var store = store();
        Path marker = home.resolve("session-new-marker");
        ExecutorService executor = Executors.newSingleThreadExecutor();
        try (var runtime = runtime("-Dloopra.fake.sessionNewDelay=1500", "-Dloopra.fake.sessionNewMarker=" + marker)) {
            Future<?> preparation = executor.submit(() -> {
                try { return runtime.configuration("key", home, "chat", store, null, null); }
                catch (Exception e) { throw new RuntimeException(e); }
            });
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8);
            while (!java.nio.file.Files.exists(marker) && System.nanoTime() < deadline) Thread.sleep(25);
            assertTrue(java.nio.file.Files.exists(marker), "configuration request must reach session setup");
            // Selecting a freshly created session starts a configuration read that may spawn
            // the Agent process. A message sent at that moment must wait for the setup rather
            // than fail as if the conversation were already running.
            prompt(runtime, store, "after preparation", AgentOutput.NOOP);
            preparation.get(8, TimeUnit.SECONDS);
            assertTrue(store.load("chat").stream().anyMatch(message -> "reply:after preparation".equals(message.getContent())));
        } finally { executor.shutdownNow(); store.shutdown(); }
    }

    @Test void aSecondPromptForAGenuinelyRunningTurnIsStillRejectedAtOnce() throws Exception {
        var store = store();
        var active = new AtomicReference<AcpWorkbenchClient>();
        var ready = new CountDownLatch(1);
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try (var runtime = runtime()) {
            AgentOutput output = new SseAgentOutput(new SseEmitter(new ContextEmpty())) {
                @Override public void sendEvent(String type, String data) { if (type.equals("choice")) ready.countDown(); }
            };
            Future<?> turn = worker.submit(() -> {
                try {
                    runtime.prompt("key", home, "chat", store, UserMessage.of("permission"), output, false,
                            null, List.of(), active::set, ignored -> {});
                } catch (Exception e) { throw new RuntimeException(e); }
            });
            assertTrue(ready.await(8, TimeUnit.SECONDS));
            var rejected = assertThrows(ServiceException.class, () -> prompt(runtime, store, "again", AgentOutput.NOOP));
            assertEquals(409, rejected.getCode());
            assertTrue(rejected.getMessage().contains("当前会话正在运行"), rejected.getMessage());
            active.get().cancel();
            turn.get(8, TimeUnit.SECONDS);
        } finally { worker.shutdownNow(); store.shutdown(); }
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
