package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.noear.snack4.ONode;
import org.noear.solon.core.handle.ContextEmpty;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.bin.session.JsonlSessionStore;
import site.sorghum.loopra.bin.session.SessionStore;
import site.sorghum.loopra.bin.session.SubAgentSessionStore;
import site.sorghum.loopra.tool.AgentOutput;

import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

@Timeout(25)
class CodexSubAgentSessionsTest {
    @TempDir Path home;

    private ExternalAcpSessions runtime(String... options) {
        List<String> command = new ArrayList<>(List.of(Path.of(System.getProperty("java.home"), "bin", "java").toString()));
        command.addAll(List.of(options));
        command.addAll(List.of("-cp", System.getProperty("surefire.test.class.path", System.getProperty("java.class.path")), FakeAcpProcess.class.getName()));
        return new ExternalAcpSessions(cwd -> new AcpProcessTransport(command, Map.of(), cwd), (key, cwd) -> List.of());
    }

    private JsonlSessionStore store() throws Exception {
        var store = new JsonlSessionStore(home.resolve("sessions"));
        store.setAcpBinding("chat", new SessionStore.AcpBinding("codex", null, null));
        return store;
    }

    private void prompt(ExternalAcpSessions runtime, SessionStore store, String text, AgentOutput output) throws Exception {
        runtime.prompt("key", home, "chat", store, UserMessage.of(text), output, false, null, List.of(), ignored -> {}, ignored -> {});
    }

    private static class Output extends SseAgentOutput {
        final List<String> types = new CopyOnWriteArrayList<>();
        final List<ONode> events = new CopyOnWriteArrayList<>();
        final StringBuilder text = new StringBuilder();
        Output() throws java.io.IOException { super(new SseEmitter(new ContextEmpty())); }
        @Override public void onContentDelta(String token) { text.append(token); }
        @Override public void sendEvent(String type, String data) {
            types.add(type);
            events.add(ONode.ofJson(data).set("type", type));
        }
    }

    @Test void negotiatedChildrenAreStreamedAndPersistedWithoutLeakingIntoRootHistory() throws Exception {
        var store = store();
        var output = new Output();
        try (var runtime = runtime()) {
            // The UI prepares configuration before the first prompt; that path must negotiate too.
            runtime.configuration("key", home, "chat", store, null, null);
            prompt(runtime, store, "native-agent", output);
            assertEquals("root finished", output.text.toString());
            assertEquals(2, output.types.stream().filter("sub_start"::equals).count());
            assertTrue(output.types.containsAll(List.of("sub_reasoning", "sub_tool_call", "sub_tool_result", "sub_end")));
            assertFalse(output.types.contains("usage"), "Child context usage must not overwrite the root context");
            assertTrue(output.events.stream().anyMatch(event -> "grandchild".equals(event.get("subId").getString())
                    && "child-1".equals(event.get("parentSubId").getString())));
            assertEquals(List.of("native-agent", "root finished"), store.load("chat").stream().map(message -> message.getContent()).toList());
            var replay = new SubAgentSessionStore(home.resolve("sessions"));
            assertEquals(2, replay.list("chat").size());
            assertTrue(replay.list("chat").stream().allMatch(child -> "completed".equals(child.status())));
            var child = replay.events("chat", "child-1");
            assertEquals(1, child.stream().filter(event -> "sub_start".equals(event.get("type"))).count());
            assertTrue(child.stream().anyMatch(event -> "child answer".equals(event.get("token"))));
            assertTrue(child.stream().anyMatch(event -> "file contents".equals(event.get("result")) && "Read".equals(event.get("name"))));
        } finally { store.shutdown(); }
    }

    @Test void loadingReconstructsChildHistoryWithoutReemittingOrDuplicatingIt() throws Exception {
        var store = store();
        var replay = new SubAgentSessionStore(home.resolve("sessions"));
        try {
            try (var runtime = runtime()) { prompt(runtime, store, "native-agent", new Output()); }
            int originalEvents = replay.events("chat", "child-1").size();
            for (int i = 0; i < 2; i++) {
                var output = new Output();
                try (var runtime = runtime("-Dloopra.fake.replayChildren=true")) {
                    if (i == 1) runtime.configuration("key", home, "chat", store, null, null);
                    prompt(runtime, store, "next", output);
                }
                assertEquals("reply:next", output.text.toString());
                assertFalse(output.types.stream().anyMatch(type -> type.startsWith("sub_")), output.types.toString());
                assertEquals(originalEvents, replay.events("chat", "child-1").size());
                assertEquals(2, replay.list("chat").size());
            }
            assertEquals(6, store.load("chat").size());
        } finally { store.shutdown(); }
    }

    @ParameterizedTest @ValueSource(strings = {"native-permission", "native-root-permission"})
    void childAndRootRoutedApprovalsResolveTheOriginalRequest(String text) throws Exception {
        var store = store();
        var active = new AtomicReference<AcpWorkbenchClient>();
        var ready = new CountDownLatch(1);
        var output = new Output() {
            @Override public void sendEvent(String type, String data) {
                super.sendEvent(type, data);
                if (type.equals("sub_choice")) ready.countDown();
            }
        };
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try (var runtime = runtime()) {
            Future<?> turn = worker.submit(() -> {
                try { runtime.prompt("key", home, "chat", store, UserMessage.of(text), output, false, null, List.of(), active::set, ignored -> {}); }
                catch (Exception e) { throw new RuntimeException(e); }
            });
            assertTrue(ready.await(8, TimeUnit.SECONDS));
            var pending = active.get().pendingPermissions();
            assertEquals("child-1", pending.get(0).get("subId"));
            active.get().resolvePermission((String) pending.get(0).get("permissionRequestId"), "allow");
            turn.get(8, TimeUnit.SECONDS);
            assertTrue(active.get().pendingPermissions().isEmpty());
            assertTrue(output.types.contains("permission_resolved"));
        } finally { worker.shutdownNow(); store.shutdown(); }
    }

    @ParameterizedTest @ValueSource(strings = {"native-wait", "legacy-codex-wait"})
    void cancellingRootClosesChildRecordsAndAllowsTheNextTurn(String text) throws Exception {
        var store = store();
        var active = new AtomicReference<AcpWorkbenchClient>();
        var ready = new CountDownLatch(1);
        var output = new Output() {
            @Override public void sendEvent(String type, String data) {
                super.sendEvent(type, data);
                if (type.equals("sub_start")) ready.countDown();
            }
        };
        ExecutorService worker = Executors.newSingleThreadExecutor();
        try (var runtime = runtime()) {
            Future<?> turn = worker.submit(() -> {
                try { runtime.prompt("key", home, "chat", store, UserMessage.of(text), output, false, null, List.of(), active::set, ignored -> {}); }
                catch (Exception e) { throw new RuntimeException(e); }
            });
            assertTrue(ready.await(8, TimeUnit.SECONDS));
            active.get().cancel();
            turn.get(8, TimeUnit.SECONDS);
            assertEquals("aborted", new SubAgentSessionStore(home.resolve("sessions")).list("chat").get(0).status());
            prompt(runtime, store, "next", new Output());
        } finally { worker.shutdownNow(); store.shutdown(); }
    }

    @Test void agentsWithoutTheCapabilityRetainOrdinaryToolFallback() throws Exception {
        var store = store();
        var output = new Output();
        try (var runtime = runtime("-Dloopra.fake.noSubagents=true")) {
            prompt(runtime, store, "native-agent", output);
            assertFalse(output.types.contains("sub_start"));
            assertTrue(store.load("chat").stream().anyMatch(message -> message.getToolCalls() != null));
            assertTrue(new SubAgentSessionStore(home.resolve("sessions")).list("chat").isEmpty());
        } finally { store.shutdown(); }
    }

    @ParameterizedTest @ValueSource(strings = {"legacy-codex", "legacy-codex-failure"})
    void legacyCollaborationToolsAlsoCreateTabsAndReplayWithoutDuplicateAnswers(String text) throws Exception {
        var store = store();
        var output = new Output();
        try (var runtime = runtime("-Dloopra.fake.noSubagents=true")) {
            prompt(runtime, store, text, output);
            assertEquals(1, output.types.stream().filter("sub_start"::equals).count());
            assertEquals(1, output.types.stream().filter("sub_end"::equals).count());
            assertEquals("legacy-child", output.events.stream().filter(event -> "sub_start".equals(event.get("type").getString())).findFirst().orElseThrow().get("subSessionId").getString());
            assertEquals("root finished", output.text.toString());
            var replay = new SubAgentSessionStore(home.resolve("sessions"));
            assertEquals(text.endsWith("failure") ? "error" : "completed", replay.list("chat").get(0).status());
            assertEquals(1, replay.events("chat", "legacy-child").stream().filter(event -> "child review".equals(event.get("token"))).count());
        } finally { store.shutdown(); }
    }

    @Test void failuresAndOpaqueSessionIdsHaveStableReplayRecords() throws Exception {
        var store = store();
        try {
            try (var runtime = runtime()) { prompt(runtime, store, "native-failure", new Output()); }
            var replay = new SubAgentSessionStore(home.resolve("sessions"));
            assertEquals("error", replay.list("chat").get(0).status());
            for (String id : List.of("child/a", "child?a")) {
                try (var runtime = runtime("-Dloopra.fake.childId=" + id)) { prompt(runtime, store, "native-agent", new Output()); }
            }
            assertEquals(4, replay.list("chat").size(), "Distinct opaque IDs must not collide after sanitizing");
            assertTrue(replay.list("chat").stream().allMatch(item -> SubAgentSessionStore.isValidSubSessionId(item.subSessionId())));
        } finally { store.shutdown(); }
    }

    @Test void legacyHistoryRebuildsReplayWithoutEmittingLiveTabsOrDuplicatingRecords() throws Exception {
        var store = store();
        try {
            try (var runtime = runtime("-Dloopra.fake.noSubagents=true")) { prompt(runtime, store, "next", new Output()); }
            var replay = new SubAgentSessionStore(home.resolve("sessions"));
            for (int attempt = 0; attempt < 2; attempt++) {
                var output = new Output();
                try (var runtime = runtime("-Dloopra.fake.noSubagents=true", "-Dloopra.fake.replayLegacyChildren=true")) {
                    prompt(runtime, store, "next", output);
                }
                assertEquals("reply:next", output.text.toString());
                assertFalse(output.types.contains("sub_start"));
                assertEquals(1, replay.list("chat").size());
                assertEquals("completed", replay.list("chat").get(0).status());
                assertEquals(3, replay.events("chat", "legacy-child").size());
            }
        } finally { store.shutdown(); }
    }

    @Test void similarlyNamedToolsFromOtherProvidersDoNotCreateCodexChildren() throws Exception {
        var store = store();
        store.setAcpBinding("chat", new SessionStore.AcpBinding("claude-code", null, null));
        try (var runtime = runtime()) {
            var output = new Output();
            prompt(runtime, store, "legacy-codex", output);
            assertFalse(output.types.contains("sub_start"));
        } finally { store.shutdown(); }
    }
}
