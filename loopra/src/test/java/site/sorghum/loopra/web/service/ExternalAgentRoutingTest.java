package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.noear.solon.core.handle.ContextEmpty;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.web.common.ServiceException;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/** Exercises workbench routing with real stdio processes, without a model or credentials. */
@Timeout(30)
class ExternalAgentRoutingTest {
    @TempDir Path home;
    private String previousHome;
    private Path project;
    private final List<String> launches = new ArrayList<>();

    @BeforeEach void setup() throws Exception {
        previousHome = System.getProperty("user.home");
        System.setProperty("user.home", home.toString());
        project = Files.createDirectories(home.resolve("project"));
    }

    @AfterEach void cleanup() { System.setProperty("user.home", previousHome); }

    private AgentService service() {
        var runtime = new ExternalAcpSessions((id, cwd) -> {
            launches.add(id);
            return new AcpProcessTransport(List.of(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                    "-cp", System.getProperty("surefire.test.class.path", System.getProperty("java.class.path")),
                    FakeAcpProcess.class.getName()), Map.of(), cwd);
        }, (key, cwd) -> List.of());
        return new AgentService(runtime);
    }

    @Test void providersKeepSeparateConfigurationBindingsAndRecoveryThroughTheWorkbench() throws Exception {
        String path = project.toString();
        try (var service = service()) {
            for (String id : List.of("claude-code", "codex", "pi", "dsh")) {
                service.selectSessionAgent(path, id, id);
                service.agentConfiguration(path, id, null, null);
                if (id.equals("codex")) service.agentConfiguration(path, id, "model", "beta");
                String events = run(service, id, "state");
                assertFalse(events.contains("event: error"), events);
                assertTrue(events.contains("reply:state:" + (id.equals("codex") ? "beta" : "alpha") + ":default"), events);
                assertEquals(id, service.sessionAgentId(path, id));
                assertThrows(ServiceException.class, () -> service.selectSessionAgent(path, id, "native"));
            }
            assertEquals(0, service.getCacheSize(), "External conversations must not construct Native Agents");
        }
        try (var service = service()) {
            for (String id : List.of("claude-code", "codex", "pi", "dsh")) {
                String events = run(service, id, "state");
                assertFalse(events.contains("event: error"), events);
                assertFalse(events.contains("OLD REPLAY"));
                assertTrue(events.contains("reply:state:" + (id.equals("codex") ? "beta" : "alpha") + ":default"), events);
                assertEquals(id, service.sessionAgentId(path, id));
                assertEquals(2, service.getHistory(path, id).stream().filter(message -> message.isUser()).count());
            }
        }
        assertEquals(List.of("claude-code", "codex", "pi", "dsh", "claude-code", "codex", "pi", "dsh"), launches);
    }

    @Test void emptySessionCanSwitchProvidersAndIsolationResetKeepsCodexIdentity() throws Exception {
        String path = project.toString();
        try (var service = service()) {
            service.selectSessionAgent(path, "draft", "claude-code");
            // No remote session exists yet, so changing the draft's engine is permitted.
            service.selectSessionAgent(path, "draft", "codex");
            service.setSessionWorktreeMode(path, "draft", false);
            assertEquals("codex", service.sessionAgentId(path, "draft"));
            service.agentConfiguration(path, "draft", null, null);
            assertEquals(List.of("codex"), launches);
            assertThrows(ServiceException.class, () -> service.selectSessionAgent(path, "draft", "unknown"));
        }
    }

    private String run(AgentService service, String session, String text) throws Exception {
        var context = new ContextEmpty();
        service.chatStream(UserMessage.of(text), project.toString(), session, new SseEmitter(context),
                null, null, null, null, null, null, List.of());
        return ((ByteArrayOutputStream) context.outputStream()).toString(StandardCharsets.UTF_8);
    }
}
