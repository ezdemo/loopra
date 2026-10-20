package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.io.TempDir;
import org.noear.solon.core.handle.ContextEmpty;
import site.sorghum.loopra.bin.agent.model.UserMessage;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.*;

import static org.junit.jupiter.api.Assertions.*;

/** Explicit opt-in: existing Codex credentials, real inference, and a temporary project. */
@EnabledIfSystemProperty(named = "loopra.test.codex", matches = "true")
@Timeout(240)
class CodexAcpSmokeTest {
    @TempDir Path project;
    @TempDir Path loopraHome;
    private String previousHome;

    @BeforeEach void isolateWorkbenchData() {
        previousHome = System.getProperty("user.home");
        // This JVM property isolates Loopra; the Node child retains the real OS home for Codex login.
        System.setProperty("user.home", loopraHome.toString());
    }
    @AfterEach void restoreWorkbenchHome() { System.setProperty("user.home", previousHome); }

    @Test void realConversationToolsPermissionsAndRestartResume() throws Exception {
        String path = project.toString();
        String name = "codex-smoke-" + UUID.randomUUID();
        String token = "LOOPRA_" + UUID.randomUUID().toString().replace("-", "");
        try (var service = new AgentService()) {
            service.selectSessionAgent(path, name, "codex");
            var options = service.agentConfiguration(path, name, null, null);
            var mode = options.stream().filter(option -> "mode".equals(option.category())).findFirst().orElseThrow();
            assertTrue(mode.accepts("read-only"));
            service.agentConfiguration(path, name, mode.id(), "read-only");
            String first = run(service, name, "Remember this token: " + token + ". Reply with the token only. Do not use tools.");
            assertFalse(first.contains("event: error"), first);
            assertTrue(replyText(first).contains(token), first);
            String second = run(service, name, "Reply with the exact token from my previous message. Do not use tools.");
            assertFalse(second.contains("event: error"), second);
            assertTrue(replyText(second).contains(token), second);
            assertEquals(0, service.getCacheSize());
        }
        try (var service = new AgentService()) {
            assertEquals("codex", service.sessionAgentId(path, name));
            String resumed = run(service, name, "Reply with the exact token I asked you to remember. Do not use tools.");
            assertFalse(resumed.contains("event: error"), resumed);
            assertTrue(replyText(resumed).contains(token), resumed);
            Files.writeString(project.resolve("input.txt"), "LOOPRA_TOOL_INPUT");
            ExecutorService worker = Executors.newSingleThreadExecutor();
            try {
                Future<String> result = worker.submit(() -> run(service, name,
                        "Read input.txt. Then write exactly LOOPRA_TOOL_OUTPUT to output.txt in this project. "
                                + "You are in read-only mode: request permission for the write. Do not modify any other files."));
                int approvals = 0;
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(120);
                while (!result.isDone() && System.nanoTime() < deadline) {
                    for (var permission : service.pendingAcpPermissions(path, name)) {
                        @SuppressWarnings("unchecked") var choices = (List<java.util.Map<String, Object>>) permission.get("options");
                        var allow = choices.stream().filter(choice -> "allow_once".equals(choice.get("kind"))).findFirst().orElseThrow();
                        service.resolveAcpPermission(path, name, (String) permission.get("permissionRequestId"), (String) allow.get("value"));
                        approvals++;
                    }
                    Thread.sleep(50);
                }
                String events = result.get(5, TimeUnit.SECONDS);
                assertFalse(events.contains("event: error"), events);
                assertTrue(events.contains("event: tool_call"), events);
                assertTrue(approvals > 0, "A real write permission was expected");
                assertEquals("LOOPRA_TOOL_OUTPUT", Files.readString(project.resolve("output.txt")).trim());
            } finally { worker.shutdownNow(); }
            assertEquals(4, service.getHistory(path, name).stream().filter(message -> message.isUser()).count());
            assertEquals(0, service.getCacheSize());
        }
    }

    private String run(AgentService service, String name, String text) throws Exception {
        var context = new ContextEmpty();
        service.chatStream(UserMessage.of(text), project.toString(), name, new SseEmitter(context),
                null, null, null, null, null, null, List.of());
        return ((ByteArrayOutputStream) context.outputStream()).toString(StandardCharsets.UTF_8);
    }

    private String replyText(String events) {
        StringBuilder text = new StringBuilder();
        for (String frame : events.split("\\r?\\n\\r?\\n")) {
            if (!frame.startsWith("event: content")) continue;
            frame.lines().filter(line -> line.startsWith("data: ")).findFirst()
                    .ifPresent(line -> text.append(org.noear.snack4.ONode.ofJson(line.substring(6)).getString()));
        }
        return text.toString();
    }
}
