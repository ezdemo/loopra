package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.io.TempDir;
import org.noear.solon.core.handle.ContextEmpty;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.bin.config.ConfigService;
import site.sorghum.loopra.bin.session.JsonlSessionStore;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

import static org.junit.jupiter.api.Assertions.*;

/** Explicit opt-in only: uses the installed Claude login, real inference, and a temporary project. */
@EnabledIfSystemProperty(named="loopra.test.claude", matches="true")
@Timeout(180)
class ClaudeAcpSmokeTest {
    @TempDir Path project;

    @Test void workbenchSupportsRealToolsApprovalsMultipleTurnsAndRestartResume() throws Exception {
        ConfigService.reload();
        String path = project.toString();
        String name = "claude-smoke-" + UUID.randomUUID();
        AgentService service = new AgentService();
        service.selectSessionAgent(path, name, "claude-code");
        try {
            var config = service.agentConfiguration(path, name, null, null);
            var model = config.stream().filter(option -> "model".equals(option.category())).findFirst().orElseThrow();
            assertFalse(model.options().isEmpty());
            String selectedModel = model.options().stream().filter(value -> value.value().equals(model.currentValue()))
                    .findFirst().orElse(model.options().get(0)).value();
            service.agentConfiguration(path, name, model.id(), selectedModel);
            var mode = config.stream().filter(option -> "mode".equals(option.category())).findFirst().orElseThrow();
            var planned = service.agentConfiguration(path, name, mode.id(), "plan");
            assertEquals("plan", planned.stream().filter(option -> option.id().equals(mode.id())).findFirst().orElseThrow().currentValue());
            service.agentConfiguration(path, name, mode.id(), "default");
            String first = run(service, path, name, "Reply exactly LOOPRA_ACP_OK. Do not use tools or access files.");
            assertTrue(replyText(first).contains("LOOPRA_ACP_OK"), first);
            assertFalse(first.contains("event: error"), first);
            String second = run(service, path, name, "What exact token did you reply in the previous turn? Reply only that token. Do not use tools.");
            assertTrue(replyText(second).contains("LOOPRA_ACP_OK"), second);
        } finally { service.close(); }

        // A new backend service must use the persisted remote session, never a fresh conversation.
        service = new AgentService();
        try {
            String resumed = run(service, path, name, "What exact token did you reply before? Reply only that token. Do not use tools.");
            assertTrue(replyText(resumed).contains("LOOPRA_ACP_OK"), resumed);
            Files.writeString(project.resolve("input.txt"), "LOOPRA_TOOL_INPUT");
            AgentService active = service;
            ExecutorService worker = Executors.newSingleThreadExecutor();
            try {
                Future<String> result = worker.submit(() -> run(active, path, name,
                        "In the current working directory, read input.txt, then use your Write tool to create output.txt with exactly LOOPRA_TOOL_OUTPUT. Do not run shell commands. Reply DONE when finished."));
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(90);
                int approvals = 0;
                while (!result.isDone() && System.nanoTime() < deadline) {
                    for (var pending : service.pendingAcpPermissions(path, name)) {
                        String id = (String) pending.get("permissionRequestId");
                        @SuppressWarnings("unchecked") var options = (List<Map<String, String>>) pending.get("options");
                        String option = options.stream().filter(value -> "allow_once".equals(value.get("kind")))
                                .map(value -> value.get("value")).findFirst().orElseThrow();
                        service.resolveAcpPermission(path, name, id, option); approvals++;
                    }
                    Thread.sleep(50);
                }
                String events = result.get(5, TimeUnit.SECONDS);
                assertFalse(events.contains("event: error"), events);
                assertTrue(events.contains("event: tool_call"), events);
                assertTrue(events.contains("event: tool_result"), events);
                assertTrue(approvals > 0, "A real Write permission was expected");
                assertEquals("LOOPRA_TOOL_OUTPUT", Files.readString(project.resolve("output.txt")).trim());
            } finally { worker.shutdownNow(); }
            var history = service.getHistory(path, name);
            assertEquals(4, history.stream().filter(message -> message.isUser()).count());
            assertEquals(0, service.getCacheSize(), "Claude must not construct a Native Agent");
            assertThrows(RuntimeException.class, () -> active.selectSessionAgent(path, name, "native"));
        } finally { service.close(); }
    }

    private String run(AgentService service, String path, String name, String text) throws Exception {
        ContextEmpty context = new ContextEmpty();
        service.chatStream(UserMessage.of(text), path, name, new SseEmitter(context), null, null, null, null, null, null, List.of());
        return ((ByteArrayOutputStream) context.outputStream()).toString(StandardCharsets.UTF_8);
    }
    private String replyText(String events) {
        StringBuilder result = new StringBuilder();
        for (String frame : events.split("\\r?\\n\\r?\\n")) {
            if (frame.startsWith("event: content")) {
                String data = frame.lines().filter(line -> line.startsWith("data: ")).findFirst().orElse("data: \"\"");
                result.append(org.noear.snack4.ONode.ofJson(data.substring(6)).getString());
            }
        }
        return result.toString();
    }
}
