package site.sorghum.loopra.bin.acp;

import com.agentclientprotocol.sdk.agent.support.AcpAgentSupport;
import com.agentclientprotocol.sdk.client.AcpClient;
import com.agentclientprotocol.sdk.spec.AcpSchema.*;
import org.junit.jupiter.api.Test;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.tool.AgentOutput;
import site.sorghum.loopra.tool.ChoiceOption;
import site.sorghum.loopra.tool.LogLevel;
import site.sorghum.loopra.web.service.AcpWorkbenchClient;

import java.util.List;
import java.util.Map;
import java.util.concurrent.*;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.*;

class NativeAcpProtocolTest {
    @Test
    void nativeSessionsRestoreOnceAndNewSessionsDoNotInheritDefaultHistory(
            @org.junit.jupiter.api.io.TempDir java.nio.file.Path workspace) throws Exception {
        AcpSessionManager first = nativeSessions();
        String id;
        try {
            try (Connection connection = new Connection(first, new RecordingOutput(), workspace.toString())) {
                id = connection.id;
                connection.client.prompt(UserMessage.of("persisted question"), Map.of());
            }
            first.closeSession(id);
        } finally { first.dispose(); }
        java.nio.file.Path directory = site.sorghum.loopra.bin.project.ProjectRegistry.getOrCreate(workspace.toString())
                .getSessionsDir(workspace.toString());
        java.nio.file.Files.copy(directory.resolve(id + ".jsonl"), directory.resolve("default.jsonl"),
                java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        AcpSessionManager restored = nativeSessions();
        try {
            String fresh = restored.createSession(workspace.toString(), "fresh");
            assertTrue(restored.history(fresh).stream().noneMatch(ChatMessage::isUser));
            assertTrue(restored.loadOrRestoreSession(id, workspace.toString()));
            assertEquals(1, restored.history(id).stream().filter(ChatMessage::isUser).count());
            assertEquals("persisted question", restored.history(id).stream().filter(ChatMessage::isUser)
                    .findFirst().orElseThrow().getContent());
            assertFalse(restored.loadOrRestoreSession(id, workspace.resolve("other-project").toString()));
        } finally { restored.dispose(); }
    }

    private static AcpSessionManager nativeSessions() throws Exception {
        return new AcpSessionManager(settings -> site.sorghum.loopra.bin.model.TestLoopraProvider.builder()
                .model(settings.model()).channelId(settings.modelChannelId())
                .stream(request -> site.sorghum.loopra.bin.model.TestLoopraProvider.contentStream("done")).build());
    }

    @Test
    void stdioEntryReservesStdoutForProtocol(@org.junit.jupiter.api.io.TempDir java.nio.file.Path home) throws Exception {
        String javaCommand = java.nio.file.Path.of(System.getProperty("java.home"), "bin", "java").toString();
        String classpath = System.getProperty("surefire.test.class.path", System.getProperty("java.class.path"));
        Process process = new ProcessBuilder(javaCommand, "-Duser.home=" + home, "-cp", classpath,
                "site.sorghum.loopra.web.LoopraWebApp", "--loopra.acp=true", "--loopra.acp.ws.port=0")
                .redirectError(home.resolve("stdio.log").toFile()).start();
        ExecutorService reader = Executors.newSingleThreadExecutor();
        try {
            var input = new java.io.BufferedWriter(new java.io.OutputStreamWriter(process.getOutputStream(), java.nio.charset.StandardCharsets.UTF_8));
            input.write("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":1,\"clientCapabilities\":{}}}\n");
            input.flush();
            Future<String> line = reader.submit(() -> new java.io.BufferedReader(new java.io.InputStreamReader(
                    process.getInputStream(), java.nio.charset.StandardCharsets.UTF_8)).readLine());
            String firstLine = line.get(10, TimeUnit.SECONDS);
            var result = org.noear.snack4.ONode.ofJson(firstLine);
            assertEquals("2.0", result.get("jsonrpc").getString());
            assertEquals(1, result.get("id").getInt());
            assertEquals(1, result.get("result").get("protocolVersion").getInt());
            assertEquals("26.9.91", result.get("result").get("agentInfo").get("version").getString());
            input.close();
            assertTrue(process.waitFor(10, TimeUnit.SECONDS));
        } finally { process.destroyForcibly(); reader.shutdownNow(); }
    }

    @Test
    void toolsKeepIdentityAndExplicitFailureAcrossJsonRpc() throws Exception {
        Backend backend = new Backend(output -> {
            output.onToolCall("first", "read", "{\"path\":\"a\"}");
            output.onToolCall("second", "read", "{\"path\":\"b\"}");
            output.onToolResult("second", "read", "looks successful", true);
            output.onToolResult("first", "read", "a contents", false);
            output.onContentDelta("answer");
            output.sendEvent("sub_start", "{\"subId\":7}");
            output.sendEvent("file_changes", "{\"changes\":[]}");
            return "answer";
        });
        RecordingOutput output = new RecordingOutput();
        try (Connection connection = new Connection(backend, output)) {
            assertEquals(StopReason.END_TURN, connection.client.prompt(UserMessage.of("hello"), Map.of()).stopReason());
            assertEquals(List.of("first:read", "second:read"), output.calls);
            assertEquals(List.of("second:true:looks successful", "first:false:a contents"), output.results);
            assertEquals("answer", output.text.toString());
            assertTrue(output.events.contains("sub_start"));
            assertTrue(output.events.contains("file_changes"));
            assertTrue(output.events.contains("complete"));
        }
    }

    @Test
    void nativeToolResultsReportChangesAsStandardAcpDiffContent() throws Exception {
        Backend backend = new Backend(output -> {
            output.onToolCall("edit-1", "write", "{\"path\":\"a.txt\"}");
            output.onToolResult("edit-1", "write", "written", false, List.of(
                    new site.sorghum.loopra.bin.session.SessionFileChangeTracker.ToolChange(
                            "a.txt", "old line\n", "new line\n", false)));
            return "done";
        });
        CompletableFuture<ToolCallUpdateNotification> completedUpdate = new CompletableFuture<>();
        try (JsonRpcLoopback wire = new JsonRpcLoopback()) {
            LoopraAcpAgent nativeAgent = new LoopraAcpAgent(backend);
            AcpAgentSupport server = AcpAgentSupport.create(nativeAgent).transport(wire.agent()).build();
            nativeAgent.setUpdateSender(server.getAgent()::sendSessionUpdate);
            server.start();
            try (var client = AcpClient.sync(wire.client())
                    .sessionUpdateConsumer(event -> {
                        if (event.update() instanceof ToolCallUpdateNotification update
                                && update.status() == ToolCallStatus.COMPLETED) completedUpdate.complete(update);
                    }).build()) {
                client.initialize(new InitializeRequest(1, new ClientCapabilities()));
                client.newSession(new NewSessionRequest("workspace", List.of()));
                client.prompt(new PromptRequest("native-session", List.of(new TextContent("hello"))));
                // The prompt response and session notifications are dispatched independently.
                ToolCallUpdateNotification completed = completedUpdate.get(5, TimeUnit.SECONDS);
                ToolCallDiff diff = completed.content().stream()
                        .filter(ToolCallDiff.class::isInstance).map(ToolCallDiff.class::cast)
                        .findFirst().orElseThrow();
                // `type` is the wire discriminator; the SDK restores the subtype on decode.
                assertEquals("a.txt", diff.path());
                assertEquals("old line\n", diff.oldText());
                assertEquals("new line\n", diff.newText());
                assertTrue(completed.content().stream().anyMatch(ToolCallContentBlock.class::isInstance));
            } finally { server.close(); }
        }
    }

    @Test
    void imagesAndNativeOptionsSurviveSerialization() throws Exception {
        Backend backend = new Backend(output -> "done");
        try (Connection connection = new Connection(backend, new RecordingOutput())) {
            connection.client.prompt(UserMessage.of("图片", List.of("data:image/png;base64,YWJj")),
                    Map.of("snapshotId", "checkpoint", "fastMode", true));
            assertEquals("图片", backend.text);
            assertEquals(List.of("data:image/png;base64,YWJj"), backend.images);
            assertEquals(Map.of("snapshotId", "checkpoint", "fastMode", true), backend.options);
        }
    }

    @Test
    void permissionRoundTripSupportsAllowAndDenyWithoutAnotherPrompt() throws Exception {
        for (String option : List.of("/agree", "/deny")) {
            Backend backend = new Backend(output -> {
                output.onChoice(List.of(new ChoiceOption("/agree", "允许"), new ChoiceOption("/deny", "拒绝")),
                        "write", "a.txt");
                assertEquals("/agree".equals(option), output.takePermissionDecision());
                return "done";
            });
            RecordingOutput output = new RecordingOutput();
            ExecutorService executor = Executors.newSingleThreadExecutor();
            try (Connection connection = new Connection(backend, output)) {
                Future<PromptResponse> prompt = executor.submit(() -> connection.client.prompt(UserMessage.of("edit"), Map.of()));
                assertTrue(output.permission.await(5, TimeUnit.SECONDS));
                assertFalse(prompt.isDone());
                String id = (String) connection.client.pendingPermissions().get(0).get("permissionRequestId");
                assertThrows(RuntimeException.class, () -> connection.client.resolvePermission("wrong-session", option));
                assertThrows(RuntimeException.class, () -> connection.client.resolvePermission(id, "invalid-option"));
                connection.client.resolvePermission(id, option);
                assertEquals(StopReason.END_TURN, prompt.get(5, TimeUnit.SECONDS).stopReason());
                assertEquals(1, backend.prompts);
                assertTrue(connection.client.pendingPermissions().isEmpty());
                assertTrue(output.events.contains("permission_resolved"));
            } finally { executor.shutdownNow(); }
        }
    }

    @Test
    void cancellationReleasesPermissionAndReturnsCancelled() throws Exception {
        Backend backend = new Backend(output -> {
            output.onChoice(List.of(new ChoiceOption("/agree", "允许"), new ChoiceOption("/deny", "拒绝")));
            assertNull(output.takePermissionDecision());
            return "";
        });
        RecordingOutput output = new RecordingOutput();
        ExecutorService executor = Executors.newSingleThreadExecutor();
        try (Connection connection = new Connection(backend, output)) {
            Future<PromptResponse> prompt = executor.submit(() -> connection.client.prompt(UserMessage.of("edit"), Map.of()));
            assertTrue(output.permission.await(5, TimeUnit.SECONDS));
            connection.client.cancel();
            assertEquals(StopReason.CANCELLED, prompt.get(5, TimeUnit.SECONDS).stopReason());
            assertTrue(connection.client.pendingPermissions().isEmpty());
        } finally { executor.shutdownNow(); }
    }

    @Test
    void executionErrorsRemainProtocolErrors() throws Exception {
        Backend backend = new Backend(output -> { throw new IllegalStateException("engine failed"); });
        RecordingOutput output = new RecordingOutput();
        try (Connection connection = new Connection(backend, output)) {
            RuntimeException failure = assertThrows(RuntimeException.class,
                    () -> connection.client.prompt(UserMessage.of("hello"), Map.of()));
            assertTrue(failure.getMessage().contains("engine failed"));
            assertFalse(output.events.contains("complete"));
        }
    }

    @Test
    void standardClientGetsReplayAndCommandResultsWithoutNativeExtensions() throws Exception {
        Backend backend = new Backend(output -> "command result");
        backend.history = List.of(ChatMessage.fromMap(Map.of("role", "user", "content", "earlier")));
        List<SessionUpdate> updates = new CopyOnWriteArrayList<>();
        CountDownLatch replayed = new CountDownLatch(2);
        try (JsonRpcLoopback wire = new JsonRpcLoopback()) {
            LoopraAcpAgent nativeAgent = new LoopraAcpAgent(backend);
            AcpAgentSupport server = AcpAgentSupport.create(nativeAgent).transport(wire.agent()).build();
            nativeAgent.setUpdateSender(server.getAgent()::sendSessionUpdate);
            server.start();
            try (var client = AcpClient.sync(wire.client()).sessionUpdateConsumer(event -> {
                updates.add(event.update()); replayed.countDown();
            }).build()) {
                assertEquals(1, client.initialize(new InitializeRequest(1, new ClientCapabilities())).protocolVersion());
                client.newSession(new NewSessionRequest("workspace", List.of()));
                client.loadSession(new LoadSessionRequest("native-session", "workspace", List.of()));
                client.prompt(new PromptRequest("native-session", List.of(new TextContent("/help"))));
                assertTrue(replayed.await(5, TimeUnit.SECONDS));
                assertTrue(updates.stream().anyMatch(UserMessageChunk.class::isInstance));
                assertTrue(updates.stream().filter(AgentMessageChunk.class::isInstance).map(AgentMessageChunk.class::cast)
                        .anyMatch(chunk -> chunk.content() instanceof TextContent text && text.text().equals("command result")));
            } finally { server.close(); }
        }
    }

    private static final class Connection implements AutoCloseable {
        final JsonRpcLoopback wire = new JsonRpcLoopback();
        final AcpAgentSupport server;
        final AcpWorkbenchClient client;
        final String id;
        Connection(AcpSessionBackend backend, AgentOutput output) { this(backend, output, "workspace"); }
        Connection(AcpSessionBackend backend, AgentOutput output, String cwd) {
            LoopraAcpAgent nativeAgent = new LoopraAcpAgent(backend);
            server = AcpAgentSupport.create(nativeAgent).transport(wire.agent()).build();
            nativeAgent.setUpdateSender(server.getAgent()::sendSessionUpdate);
            server.start();
            client = new AcpWorkbenchClient(wire.client(), output);
            id = client.open(cwd);
        }
        @Override public void close() { client.close(); server.close(); wire.close(); }
    }

    private static final class Backend implements AcpSessionBackend {
        final Function<AcpAgentOutput, String> execute;
        List<ChatMessage> history = List.of();
        volatile boolean cancelled;
        int prompts;
        String text;
        List<String> images;
        Map<String, Object> options;
        Backend(Function<AcpAgentOutput, String> execute) { this.execute = execute; }
        public String createSession(String cwd, String name) { return "native-session"; }
        public boolean loadOrRestoreSession(String id, String cwd) { return id.equals("native-session"); }
        public String handlePrompt(String id, String text, List<String> images, AcpAgentOutput output, Map<String, Object> options) {
            prompts++; this.text = text; this.images = images; this.options = options;
            return execute.apply(output);
        }
        public void cancelPrompt(String id) { cancelled = true; }
        public boolean isCancelled(String id) { return cancelled; }
        public void closeSession(String id) {}
        public List<SessionInfo> listSessions() { return List.of(new SessionInfo("native-session", "workspace")); }
        public List<ChatMessage> history(String id) { return history; }
    }

    private static final class RecordingOutput implements AgentOutput {
        final List<String> calls = new CopyOnWriteArrayList<>();
        final List<String> results = new CopyOnWriteArrayList<>();
        final List<String> events = new CopyOnWriteArrayList<>();
        final StringBuilder text = new StringBuilder();
        final CountDownLatch permission = new CountDownLatch(1);
        public void onContentDelta(String token) { text.append(token); }
        public void onContentComplete() {}
        public void onReasoningDelta(String token) {}
        public void onReasoning(String text) {}
        public void onToolCall(String name, String args) {}
        public void onToolResult(String name, String result) {}
        public void onToolCall(String id, String name, String args) { calls.add(id + ":" + name); }
        public void onToolResult(String id, String name, String result, boolean failed) { results.add(id + ":" + failed + ":" + result); }
        public void onUsage(int p, int c, int t, int h, int m) {}
        public void onError(String error) {}
        public void onLog(LogLevel level, String message) {}
        public void onChoice(List<ChoiceOption> choices) {}
        public void sendEvent(String type, String data) { events.add(type); if (type.equals("choice")) permission.countDown(); }
    }
}
