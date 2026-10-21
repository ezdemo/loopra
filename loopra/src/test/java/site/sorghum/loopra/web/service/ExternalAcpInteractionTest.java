package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.noear.snack4.ONode;
import org.noear.solon.core.handle.ContextEmpty;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.bin.session.JsonlSessionStore;
import site.sorghum.loopra.bin.session.SessionStore;
import site.sorghum.loopra.tool.AgentOutput;
import site.sorghum.loopra.tool.LogLevel;

import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

@Timeout(20)
class ExternalAcpInteractionTest {
    @TempDir Path home;
    private ExternalAcpSessions runtime() {
        var command = List.of(Path.of(System.getProperty("java.home"), "bin", "java").toString(), "-cp",
                System.getProperty("surefire.test.class.path", System.getProperty("java.class.path")), FakeAcpProcess.class.getName());
        return new ExternalAcpSessions(cwd -> new AcpProcessTransport(command, Map.of(), cwd), (key, cwd) -> List.of());
    }
    private JsonlSessionStore store(String agentId) throws Exception {
        var store = new JsonlSessionStore(home.resolve("sessions"));
        store.setAcpBinding("chat", new SessionStore.AcpBinding(agentId, null, null));
        return store;
    }
    private void prompt(ExternalAcpSessions runtime, SessionStore store, String text, AgentOutput output) throws Exception {
        runtime.prompt("key", home, "chat", store, UserMessage.of(text), output, false, null, List.of(), ignored -> {}, ignored -> {});
    }

    @Test void streamedToolOutputIsIsolatedAndSavedWithTheFinalExitStatus() throws Exception {
        var store = store("codex");
        List<ONode> updates = new CopyOnWriteArrayList<>();
        Map<String, String> results = new ConcurrentHashMap<>();
        Set<String> failed = ConcurrentHashMap.newKeySet();
        AgentOutput output = new SseAgentOutput(new SseEmitter(new ContextEmpty())) {
            @Override public void sendEvent(String type, String data) {
                if (type.equals("tool_update") || type.equals("sub_tool_update")) updates.add(ONode.ofJson(data));
            }
            @Override public void onToolResult(String id, String name, String result, boolean isFailed) {
                results.put(id, result);
                if (isFailed) failed.add(id);
            }
        };
        try {
            try (var runtime = runtime()) { prompt(runtime, store, "tool-output", output); }
            assertTrue(updates.stream().anyMatch(event -> "first\n".equals(event.get("result").getString())),
                    "The first chunk must reach the UI before completion");
            assertTrue(updates.stream().anyMatch(event -> "first\nsecond\n".equals(event.get("result").getString())));
            assertTrue(updates.stream().anyMatch(event -> "child output".equals(event.get("result").getString())
                    && event.get("subId").isString()), "Child chunks keep their route");
            assertEquals("first\nsecond\n\nExit code: 0", results.get("read-1"));
            assertEquals("command error\n\nExit code: 7", results.get("shell-1"));
            assertEquals("content output\n\nExit code: 0", results.get("content-1"));
            assertEquals(Set.of("shell-1"), failed);
            var reopened = new JsonlSessionStore(home.resolve("sessions"));
            try {
                var saved = reopened.load("chat").stream().filter(message -> "tool".equals(message.getRole())).toList();
                assertEquals(3, saved.size(), "Partial updates must not create duplicate persisted results");
                for (var message : saved) {
                    String expected = results.get(message.getToolCallId());
                    assertEquals(failed.contains(message.getToolCallId()) ? "[failed] " + expected : expected, message.getContent());
                    assertFalse(message.getContent().contains("child output"));
                }
            } finally { reopened.shutdown(); }
            var subStore = new site.sorghum.loopra.bin.session.SubAgentSessionStore(home.resolve("sessions"));
            assertTrue(subStore.events("chat", "output-child").stream().anyMatch(event ->
                    "sub_tool_result".equals(event.get("type"))
                            && "child output\n\nExit code: 0".equals(event.get("result"))));
        } finally { store.shutdown(); }
    }

    @ParameterizedTest @ValueSource(strings = {"claude-code", "codex", "codex-child", "timeout"})
    void elicitationIsNegotiatedAndAnswersResumeTheSameTurn(String variant) throws Exception {
        var store = store(variant.equals("claude-code") ? variant : "codex");
        var active = new AtomicReference<AcpWorkbenchClient>();
        var ready = new CountDownLatch(1);
        List<String> events = new CopyOnWriteArrayList<>();
        AgentOutput output = new SseAgentOutput(new SseEmitter(new ContextEmpty())) {
            @Override public void sendEvent(String type, String data) { events.add(type); if (type.equals("elicitation")) ready.countDown(); }
        };
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try (var runtime = runtime()) {
            String prompt = variant.equals("codex-child") ? "child-input" : variant.equals("timeout") ? "input-timeout" : "input";
            Future<?> turn = worker.submit(() -> {
                try { runtime.prompt("key", home, "chat", store, UserMessage.of(prompt), output, false, null, List.of(), active::set, ignored -> {}); }
                catch (Exception e) { throw new RuntimeException(e); }
            });
            assertTrue(ready.await(5, TimeUnit.SECONDS), "The adapter must see form capability and send the question");
            if (!variant.equals("timeout")) {
                var pending = active.get().pendingElicitations();
                assertEquals(1, pending.size(), "Refresh must recover the exact outstanding form");
                String id = (String) pending.get(0).get("elicitationRequestId");
                assertTrue(active.get().pendingPermissions().isEmpty(), "A question is not a permission request");
                active.get().resolveElicitation(id, "accept", Map.of("food", "chicken", "food_note", "少辣"));
            }
            turn.get(5, TimeUnit.SECONDS);
            assertTrue(active.get().pendingElicitations().isEmpty());
            assertTrue(events.contains("elicitation_resolved"));
            var history = store.load("chat");
            assertEquals(1, history.stream().filter(message -> "user".equals(message.getRole())).count(), "Answering must not create another user/model turn");
            assertTrue(history.stream().anyMatch(message -> message.getContent() != null && message.getContent().contains(
                    variant.equals("timeout") ? "cancel" : "chicken")));
        } finally { worker.shutdownNow(); store.shutdown(); }
    }

    @ParameterizedTest @ValueSource(strings = {"claude-code", "codex"})
    void plansAndCommandsAreScopedPersistedAndCanBeCleared(String agentId) throws Exception {
        var store = store(agentId);
        List<String> events = new ArrayList<>();
        AgentOutput output = new SseAgentOutput(new SseEmitter(new ContextEmpty())) {
            @Override public void sendEvent(String type, String data) { events.add(type); }
        };
        try (var runtime = runtime()) {
            prompt(runtime, store, "progress", output);
            assertTrue(events.containsAll(List.of("acp_plan", "acp_commands")));
            var saved = store.getAcpState("chat");
            assertEquals("in_progress", saved.plan().get(1).status());
            assertEquals("review", saved.commands().get(0).name());
            assertEquals("branch", saved.commands().get(0).inputHint());
            assertTrue(store.getAcpState("other").plan().isEmpty());
            var reopened = new JsonlSessionStore(home.resolve("sessions"));
            try { assertEquals(saved, reopened.getAcpState("chat")); } finally { reopened.shutdown(); }
            prompt(runtime, store, "clear-progress", output);
            assertTrue(store.getAcpState("chat").plan().isEmpty());
            assertTrue(store.getAcpState("chat").commands().isEmpty());
        } finally { store.shutdown(); }
    }

    @ParameterizedTest @ValueSource(strings = {"end_turn", "cancelled", "max_tokens", "max_turn_requests", "refusal"})
    void completionPreservesTheActualStopReason(String reason) throws Exception {
        var store = store("codex");
        List<ONode> complete = new ArrayList<>();
        List<String> warnings = new ArrayList<>();
        AgentOutput output = new SseAgentOutput(new SseEmitter(new ContextEmpty())) {
            @Override public void sendEvent(String type, String data) { if (type.equals("complete")) complete.add(ONode.ofJson(data)); }
            @Override public void onLog(LogLevel level, String text) { warnings.add(text); }
        };
        try (var runtime = runtime()) {
            prompt(runtime, store, "stop:" + reason, output);
            assertEquals(1, complete.size());
            assertEquals(reason, complete.get(0).get("stopReason").getString());
            assertEquals(reason.equals("end_turn"), "completed".equals(complete.get(0).get("status").getString()));
            assertEquals(reason.startsWith("max_") || reason.equals("refusal"), !warnings.isEmpty());
        } finally { store.shutdown(); }
    }
}
