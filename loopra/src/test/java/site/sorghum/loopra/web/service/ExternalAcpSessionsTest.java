package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.junit.jupiter.params.provider.CsvSource;
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
        return store("claude-code");
    }
    private JsonlSessionStore store(String agentId) throws Exception {
        JsonlSessionStore store = new JsonlSessionStore(home.resolve("sessions"));
        store.setAcpBinding("chat", new SessionStore.AcpBinding(agentId, null, null));
        return store;
    }

    @ParameterizedTest @ValueSource(strings = {"claude-code", "codex"})
    void managedMcpIsSentOnNewLoadAndChangedConfigurationReconnects(String agentId) throws Exception {
        Path config = home.resolve(".loopra/mcp-servers.json");
        java.nio.file.Files.createDirectories(config.getParent());
        java.nio.file.Files.writeString(config, "{\"servers\":[{\"name\":\"one\",\"type\":\"http\",\"url\":\"https://example.test/mcp\"}]}");
        var store = store(agentId);
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
        } finally { assertEquals(agentId, store.getAcpBinding("chat").agentId()); store.shutdown(); }
    }

    @ParameterizedTest @ValueSource(strings = {"claude-code", "codex"})
    void preservesConnectionAndRestoresRemoteSessionWithoutDuplicateReplay(String agentId) throws Exception {
        var store = store(agentId);
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
        } finally { assertEquals(agentId, store.getAcpBinding("chat").agentId()); store.shutdown(); }
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

    @ParameterizedTest @ValueSource(strings = {"claude-code", "codex"})
    void groupedConfigurationChangesPersistAcrossConnectionsAndDriveActualPrompts(String agentId) throws Exception {
        var store = store(agentId);
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
        } finally { assertEquals(agentId, store.getAcpBinding("chat").agentId()); store.shutdown(); }
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

    @ParameterizedTest @ValueSource(strings = {"claude-code", "codex"})
    void permissionAllowDenyAndCancelCompleteTheOriginalPrompt(String agentId) throws Exception {
        for (String selected : List.of("allow", "deny", "cancel")) {
            var store = store(agentId); var active = new AtomicReference<AcpWorkbenchClient>();
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

    @ParameterizedTest @ValueSource(strings = {"claude-code", "codex"})
    void interruptingHttpTaskReleasesConnectionAndSessionLock(String agentId) throws Exception {
        var store = store(agentId);
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
        } finally { worker.shutdownNow(); assertEquals(agentId, store.getAcpBinding("chat").agentId()); store.shutdown(); }
    }

    @ParameterizedTest @ValueSource(strings = {"claude-code", "codex"})
    void processExitFailsPromptImmediatelyAndKeepsRecoveryIdentity(String agentId) throws Exception {
        var store = store(agentId);
        try (var runtime = runtime()) {
            assertThrows(Exception.class, () -> prompt(runtime, store, "exit", AgentOutput.NOOP));
            assertEquals("fake-session", store.getAcpBinding("chat").remoteSessionId());
        } finally { assertEquals(agentId, store.getAcpBinding("chat").agentId()); store.shutdown(); }
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

    @ParameterizedTest @ValueSource(strings = {"configuration", "prompt"})
    void busyRemoteWriterReturnsConflictWithoutReplacingHistoryAndCanRecover(String operation) throws Exception {
        Path conflict = java.nio.file.Files.writeString(home.resolve("writer-conflict"), "busy");
        Path newSession = home.resolve("new-session");
        var store = store("codex");
        store.bindTo("chat");
        store.append(site.sorghum.loopra.bin.agent.model.ChatMessage.ofUser("existing history"));
        var binding = new SessionStore.AcpBinding("codex", "fake-session", home.toString());
        store.setAcpBinding("chat", binding);
        try (var runtime = runtime("-Dloopra.fake.writerConflictMarker=" + conflict,
                "-Dloopra.fake.sessionNewMarker=" + newSession)) {
            ServiceException error = assertThrows(ServiceException.class, () -> {
                if (operation.equals("configuration")) runtime.configuration("key", home, "chat", store, null, null);
                else prompt(runtime, store, "must not be appended", AgentOutput.NOOP);
            });
            assertEquals(409, error.getCode());
            assertEquals("thread_active_writer", error.getReason());
            assertTrue(error.getMessage().contains("Codex"));
            assertTrue(error.getMessage().contains("占用"));
            assertEquals(binding, store.getAcpBinding("chat"));
            assertEquals(List.of("existing history"), store.load("chat").stream().map(message -> message.getContent()).toList());
            assertFalse(java.nio.file.Files.exists(newSession), "A writer conflict must not silently create another remote session");

            java.nio.file.Files.delete(conflict);
            prompt(runtime, store, "recovered", AgentOutput.NOOP);
            assertEquals(binding, store.getAcpBinding("chat"));
            assertEquals(List.of("existing history", "recovered", "reply:recovered"),
                    store.load("chat").stream().map(message -> message.getContent()).toList());
        } finally { store.shutdown(); }
    }

    @Test
    void forksAnOccupiedRemoteSessionWithoutLoadingItAndRestoresTheForkAfterRestart() throws Exception {
        Path conflict = java.nio.file.Files.writeString(home.resolve("writer-conflict"), "busy");
        Path trace = home.resolve("requests.jsonl");
        var source = store("codex");
        var target = new JsonlSessionStore(source.sessionsDir());
        source.bindTo("chat");
        source.append(site.sorghum.loopra.bin.agent.model.ChatMessage.ofUser("existing history"));
        source.updateTitle("chat", "Original");
        source.setAcpBinding("chat", new SessionStore.AcpBinding("codex", "fake-session", home.toString()));
        source.setAgentConfig("chat", Map.of("model", "\"beta\"", "mode", "\"plan\""));
        String[] flags = {"-Dloopra.fake.writerConflictMarker=" + conflict, "-Dloopra.fake.requestTrace=" + trace};
        try {
            try (var runtime = runtime(flags)) {
                runtime.fork("fork-key", home, "chat", source, "fork", target, List.of(home.resolve("linked").toString()));
                assertEquals("fake-fork", target.getAcpBinding("fork").remoteSessionId());
                assertEquals("codex", target.getAcpBinding("fork").agentId());
                assertEquals("[复刻]Original", target.getTitle("fork"));
                assertEquals(source.getAgentConfig("chat"), target.getAgentConfig("fork"));
                assertEquals(List.of("existing history"), target.load("fork").stream().map(message -> message.getContent()).toList());
                String requests = java.nio.file.Files.readString(trace);
                assertTrue(requests.contains("\"method\":\"session/fork\""));
                assertFalse(requests.contains("\"method\":\"session/load\""));
                assertFalse(requests.contains("\"method\":\"session/new\""));
                assertTrue(requests.contains(home.resolve("linked").toString().replace("\\", "\\\\")));
                runtime.prompt("fork-key", home, "fork", target, UserMessage.of("state"), AgentOutput.NOOP,
                        false, null, List.of(home.resolve("linked").toString()), ignored -> {}, ignored -> {});
                assertTrue(target.load("fork").stream().anyMatch(message -> "reply:state:beta:plan".equals(message.getContent())));
                assertThrows(ServiceException.class, () -> runtime.configuration("source-key", home, "chat", source, null, null));
            }
            try (var runtime = runtime(flags)) {
                runtime.prompt("fork-key", home, "fork", target, UserMessage.of("continued"), AgentOutput.NOOP,
                        false, null, List.of(), ignored -> {}, ignored -> {});
            }
            assertTrue(target.load("fork").stream().anyMatch(message -> "reply:continued".equals(message.getContent())));
            assertEquals(List.of("existing history"), source.load("chat").stream().map(message -> message.getContent()).toList());
            assertEquals("fake-session", source.getAcpBinding("chat").remoteSessionId());
            assertTrue(java.nio.file.Files.exists(conflict));
            var requests = java.nio.file.Files.readAllLines(trace).stream().map(org.noear.snack4.ONode::ofJson).toList();
            assertTrue(requests.stream().filter(request -> "session/prompt".equals(request.get("method").getString()))
                    .allMatch(request -> "fake-fork".equals(request.get("params").get("sessionId").getString())));
        } finally { target.shutdown(); source.shutdown(); }
    }

    @ParameterizedTest
    @CsvSource({"codex,true", "codex,false", "claude-code,true", "claude-code,false"})
    void historicalForkCarriesTheExactPointAndExcludesLaterHistory(String agentId, boolean hasIds) throws Exception {
        Path trace = home.resolve("requests.jsonl");
        Path conflict = java.nio.file.Files.writeString(home.resolve("busy"), "busy");
        var source = store(agentId);
        var target = new JsonlSessionStore(source.sessionsDir());
        var answer = site.sorghum.loopra.bin.agent.model.ChatMessage.assistant("same answer", null, null);
        if (hasIds) answer.setAcpMessageId("selected-remote");
        source.bindTo("chat");
        source.rewrite(List.of(site.sorghum.loopra.bin.agent.model.ChatMessage.ofUser("first"),
                site.sorghum.loopra.bin.agent.model.ChatMessage.assistant("same answer", null, null),
                site.sorghum.loopra.bin.agent.model.ChatMessage.ofUser("second"), answer,
                site.sorghum.loopra.bin.agent.model.ChatMessage.ofUser("future"),
                site.sorghum.loopra.bin.agent.model.ChatMessage.assistant("do not inherit", null, null)));
        source.setAcpBinding("chat", new SessionStore.AcpBinding(agentId, "fake-session", home.toString()));
        String expectedId = hasIds ? "selected-remote" : "loopra-history-4";
        try (var runtime = runtime("-Dloopra.fake.requestTrace=" + trace, "-Dloopra.fake.writerConflictMarker=" + conflict,
                "-Dloopra.fake.expectedForkMessageId=" + expectedId)) {
            runtime.fork("branch", home, "chat", source, "branch", target, List.of(), 4);
            assertEquals(4, target.load("branch").size());
            assertEquals(6, source.load("chat").size());
            assertEquals(hasIds ? "selected-remote" : null, target.load("branch").get(3).getAcpMessageId());
            assertEquals(agentId, target.getAcpBinding("branch").agentId());
            String requests = java.nio.file.Files.readString(trace);
            assertFalse(requests.contains("\"method\":\"session/load\""));
            assertFalse(requests.contains("\"method\":\"session/new\""));
            runtime.prompt("branch", home, "branch", target, UserMessage.of("echo-fork-point"), AgentOutput.NOOP,
                    false, null, List.of(), ignored -> {}, ignored -> {});
            assertEquals("fork-point:" + expectedId, target.load("branch").get(5).getContent());
            assertEquals(6, source.load("chat").size());
        } finally { target.shutdown(); source.shutdown(); }
    }

    @Test void missingHistoricalPointSurfacesAnAgentErrorWithoutCreatingALatestHistoryFork() throws Exception {
        var source = store("codex");
        var target = new JsonlSessionStore(source.sessionsDir());
        source.bindTo("chat");
        source.rewrite(List.of(site.sorghum.loopra.bin.agent.model.ChatMessage.ofUser("question"),
                site.sorghum.loopra.bin.agent.model.ChatMessage.assistant("answer", null, null)));
        source.setAcpBinding("chat", new SessionStore.AcpBinding("codex", "fake-session", home.toString()));
        try (var runtime = runtime("-Dloopra.fake.rejectForkPoint=true")) {
            ServiceException failure = assertThrows(ServiceException.class,
                    () -> runtime.fork("branch", home, "chat", source, "branch", target, List.of(), 2));
            assertEquals(502, failure.getCode());
            assertTrue(failure.getMessage().contains("Fork point message was not found"));
            assertFalse(java.nio.file.Files.exists(source.sessionsDir().resolve("branch.jsonl")));
            assertFalse(java.nio.file.Files.exists(source.sessionsDir().resolve("branch.meta")));
            assertEquals(2, source.load("chat").size());
        } finally { target.shutdown(); source.shutdown(); }
    }

    @ParameterizedTest @ValueSource(strings = {"codex", "claude-code"})
    void recordsRemoteMessageIdsWithoutMergingDistinctAssistantMessages(String agentId) throws Exception {
        var store = store(agentId);
        try (var runtime = runtime()) {
            prompt(runtime, store, "message-ids", AgentOutput.NOOP);
            var history = store.load("chat");
            assertEquals(3, history.size());
            assertEquals("first reply", history.get(1).getContent());
            assertEquals("remote-first", history.get(1).getAcpMessageId());
            assertEquals("second reply", history.get(2).getContent());
            assertEquals("thinking", history.get(2).getReasoningContent());
            assertEquals("remote-final", history.get(2).getAcpMessageId());
        } finally { store.shutdown(); }
    }

    @ParameterizedTest
    @ValueSource(strings = {"-Dloopra.fake.noFork=true", "-Dloopra.fake.forkFailure=true",
            "-Dloopra.fake.forkId=fake-session", "-Dloopra.fake.forkId="})
    void failedForkLeavesNoPartialLocalConversationAndPreservesSource(String flag) throws Exception {
        var source = store("codex");
        var target = new JsonlSessionStore(source.sessionsDir());
        source.bindTo("chat");
        source.append(site.sorghum.loopra.bin.agent.model.ChatMessage.ofUser("existing history"));
        var binding = new SessionStore.AcpBinding("codex", "fake-session", home.toString());
        source.setAcpBinding("chat", binding);
        try (var runtime = runtime(flag)) {
            assertThrows(Exception.class, () -> runtime.fork("fork-key", home, "chat", source, "fork", target, List.of()));
            assertFalse(java.nio.file.Files.exists(source.sessionsDir().resolve("fork.jsonl")));
            assertFalse(java.nio.file.Files.exists(source.sessionsDir().resolve("fork.meta")));
            assertEquals(binding, source.getAcpBinding("chat"));
            assertEquals(List.of("existing history"), source.load("chat").stream().map(message -> message.getContent()).toList());
            // Failed setup released the reservation, so this key can be used again.
            runtime.configuration("fork-key", home, "chat", source, null, null);
        } finally { target.shutdown(); source.shutdown(); }
    }

    @Test
    void futureNotificationsDoNotProduceSdkErrorsOrInterruptFollowingReplies() throws Exception {
        var logger = (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger(
                com.agentclientprotocol.sdk.spec.AcpClientSession.class);
        var appender = new ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent>();
        appender.start();
        logger.addAppender(appender);
        var store = store("codex");
        try (var runtime = runtime("-Dloopra.fake.futureUpdates=true")) {
            prompt(runtime, store, "after metadata", AgentOutput.NOOP);
            assertEquals(List.of("after metadata", "reply:after metadata"),
                    store.load("chat").stream().map(message -> message.getContent()).toList());
            assertTrue(appender.list.stream().noneMatch(event ->
                    event.getLevel().isGreaterOrEqual(ch.qos.logback.classic.Level.WARN)),
                    () -> appender.list.stream().map(event -> event.getFormattedMessage()).toList().toString());
        } finally {
            logger.detachAppender(appender);
            appender.stop();
            store.shutdown();
        }
    }

    private void prompt(ExternalAcpSessions runtime, SessionStore store, String text, AgentOutput output,
                        String linkedProjectContext, List<String> directories) throws Exception {
        runtime.prompt("key", home, "chat", store, UserMessage.of(text), output, false,
                linkedProjectContext, directories, ignored -> {}, ignored -> {});
    }
}
