package site.sorghum.loopra.bin.acp;

import com.agentclientprotocol.sdk.agent.support.AcpAgentSupport;
import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.bin.config.*;
import site.sorghum.loopra.bin.model.TestLoopraProvider;
import site.sorghum.loopra.bin.project.ProjectRegistry;
import site.sorghum.loopra.bin.session.JsonlSessionStore;
import site.sorghum.loopra.tool.AgentOutput;
import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.service.*;
import java.nio.file.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class NativeAcpConfigurationTest {
    @TempDir Path home;
    String previousHome;
    Object previousConfig, previousSingleton;
    @BeforeEach void setup() throws Exception {
        previousHome = System.getProperty("user.home");
        previousConfig = field(ConfigService.class, "config").get(null);
        previousSingleton = field(LoopraConfig.class, "INSTANCE").get(null);
        System.setProperty("user.home", home.toString()); ConfigService.reload();
        ConfigService.updateConfig(Map.of("modelChannels", List.of(channel("one"), channel("two")),
                "model", "alpha", "modelChannelId", "one", "reasoningEffort", "high", "hitl", "free"));
    }
    private Map<String, Object> channel(String id) {
        return Map.of("id", id, "name", id, "baseUrl", "https://example.invalid/v1", "apiKey", "isolated-test",
                "models", List.of(Map.of("name", "alpha"), Map.of("name", "beta")));
    }
    @AfterEach void restore() throws Exception {
        System.setProperty("user.home", previousHome);
        field(ConfigService.class, "config").set(null, previousConfig);
        field(LoopraConfig.class, "INSTANCE").set(null, previousSingleton);
    }
    private static java.lang.reflect.Field field(Class<?> type, String name) throws Exception {
        var field = type.getDeclaredField(name); field.setAccessible(true); return field;
    }
    private AcpSessionManager manager() {
        return new AcpSessionManager(settings -> TestLoopraProvider.builder().model(settings.model()).channelId(settings.modelChannelId())
                .stream(request -> TestLoopraProvider.contentStream("done")).build());
    }

    @Test void standardProtocolChangesNativeModelChannelAndPermissionWithoutAffectingOtherSessions() throws Exception {
        AcpSessionManager manager = manager();
        try (Connection first = new Connection(manager, home.resolve("project")); Connection other = new Connection(manager, home.resolve("project"))) {
            assertTrue(first.client.configOptions().stream().anyMatch(option -> option.id().equals("model")));
            first.client.prompt(UserMessage.of("keep this history"), Map.of());
            first.client.setConfigOption("mode", "approval");
            first.client.setConfigOption("effort", "low");
            first.client.setConfigOption("model", "two:beta");
            first.client.setConfigOption("fast", "on");
            first.client.setConfigOption("plan", "on");
            var selected = manager.getAgent(first.client.sessionId());
            assertEquals("two", selected.getModelChannelId()); assertEquals("beta", selected.getModel());
            assertEquals("low", selected.getReasoningEffort());
            assertEquals("approval", selected.getHitlMode()); assertTrue(selected.isPlanMode());
            assertEquals(1, manager.history(first.client.sessionId()).stream().filter(message -> message.isUser()).count());
            assertEquals("free", manager.getAgent(other.client.sessionId()).getHitlMode());
            assertEquals("alpha", manager.getAgent(other.client.sessionId()).getModel());
            assertThrows(RuntimeException.class, () -> first.client.setConfigOption("model", "two:missing"));
            assertEquals("beta", selected.getModel());
        } finally { manager.dispose(); }
    }

    @Test void workbenchUsesTheSameProtocolAndPersistsSettingsWithoutCreatingANativeAgent() throws Exception {
        AgentService service = new AgentService();
        String path = home.resolve("workbench").toString();
        try {
            service.agentConfiguration(path, "first", "mode", "approval");
            service.agentConfiguration(path, "first", "model", "two:beta");
            service.agentConfiguration(path, "first", "effort", "low");
            var settings = service.agentConfiguration(path, "first", null, null);
            assertEquals("approval", current(settings, "mode")); assertEquals("two:beta", current(settings, "model"));
            assertEquals("low", current(settings, "effort"));
            assertEquals("free", current(service.agentConfiguration(path, "second", null, null), "mode"));
            assertEquals("free", ConfigService.getConfig().hitl());
            assertEquals(0, service.getCacheSize());
        } finally { service.close(); }
        AgentService restored = new AgentService();
        try { assertEquals("approval", current(restored.agentConfiguration(path, "first", null, null), "mode")); }
        finally { restored.close(); }
    }
    @Test void switchingAgentClearsConfigurationOwnedByThePreviousEngine() throws Exception {
        AgentService service = new AgentService();
        String path = home.resolve("switch").toString();
        try {
            service.agentConfiguration(path, "first", "mode", "approval");
            assertEquals("approval", current(service.agentConfiguration(path, "first", null, null), "mode"));
            service.selectSessionAgent(path, "first", "claude-code");
            assertEquals(Map.of(), agentConfig(path, "first"));
            service.selectSessionAgent(path, "first", "native");
            assertEquals(Map.of(), agentConfig(path, "first"));
            assertEquals("free", current(service.agentConfiguration(path, "first", null, null), "mode"));
        } finally { service.close(); }
    }
    @Test void worktreeSwitchOnEmptyClaudeSessionResetsRemoteBinding() throws Exception {
        AgentService service = new AgentService();
        String path = home.resolve("claude-worktree").toString();
        try {
            JsonlSessionStore store = new JsonlSessionStore(new ProjectRegistry().getSessionsDir(path));
            try { store.setAcpBinding("chat", new site.sorghum.loopra.bin.session.SessionStore.AcpBinding(
                    "claude-code", "remote-1", path)); }
            finally { store.shutdown(); }

            service.setSessionWorktreeMode(path, "chat", true);

            JsonlSessionStore check = new JsonlSessionStore(new ProjectRegistry().getSessionsDir(path));
            try {
                assertTrue(check.isWorktreeMode("chat"));
                var binding = check.getAcpBinding("chat");
                assertEquals("claude-code", binding.agentId());
                assertNull(binding.remoteSessionId(), "The stale cwd binding must be dropped so the next turn starts in the worktree");
                assertNull(binding.cwd());
            } finally { check.shutdown(); }
        } finally { service.close(); }
    }

    @Test void worktreeSwitchOnClaudeSessionWithMessagesIsRejected() throws Exception {
        AgentService service = new AgentService();
        String path = home.resolve("claude-worktree-messages").toString();
        try {
            JsonlSessionStore store = new JsonlSessionStore(new ProjectRegistry().getSessionsDir(path));
            try {
                store.setAcpBinding("chat", new site.sorghum.loopra.bin.session.SessionStore.AcpBinding(
                        "claude-code", "remote-1", path));
                store.bindTo("chat");
                store.append(ChatMessage.ofUser("existing history"));
            } finally { store.shutdown(); }

            ServiceException error = assertThrows(ServiceException.class,
                    () -> service.setSessionWorktreeMode(path, "chat", true));
            assertEquals(409, error.getCode());
            JsonlSessionStore check = new JsonlSessionStore(new ProjectRegistry().getSessionsDir(path));
            try {
                assertFalse(check.isWorktreeMode("chat"));
                assertEquals("remote-1", check.getAcpBinding("chat").remoteSessionId());
            } finally { check.shutdown(); }
        } finally { service.close(); }
    }

    private Map<String, String> agentConfig(String project, String name) throws Exception {
        JsonlSessionStore store = new JsonlSessionStore(new ProjectRegistry().getSessionsDir(project));
        try { return store.getAgentConfig(name); } finally { store.shutdown(); }
    }
    private Object current(List<AcpConfigOption> options, String id) { return options.stream().filter(option -> option.id().equals(id)).findFirst().orElseThrow().currentValue(); }

    private static final class Connection implements AutoCloseable {
        final JsonRpcLoopback wire = new JsonRpcLoopback();
        final AcpAgentSupport server;
        final AcpWorkbenchClient client;
        Connection(AcpSessionBackend backend, Path cwd) throws Exception {
            Files.createDirectories(cwd);
            LoopraAcpAgent nativeAgent = new LoopraAcpAgent(backend);
            server = AcpAgentSupport.create(nativeAgent).transport(wire.agent()).build();
            nativeAgent.setUpdateSender(server.getAgent()::sendSessionUpdate); server.start();
            client = new AcpWorkbenchClient(wire.client(), AgentOutput.NOOP); client.open(cwd.toString());
        }
        public void close() { client.close(); server.close(); wire.close(); }
    }
}
