package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.noear.solon.core.handle.ContextEmpty;
import site.sorghum.loopra.bin.agent.core.AgentLoop;
import site.sorghum.loopra.bin.agent.core.LoopraAgent;
import site.sorghum.loopra.bin.agent.environment.SessionEnvironment;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.bin.agent.prompt.PromptPrefix;
import site.sorghum.loopra.bin.config.ConfigService;
import site.sorghum.loopra.bin.config.LoopraConfig;
import site.sorghum.loopra.bin.model.LoopraModelProvider;
import site.sorghum.loopra.bin.model.TestLoopraProvider;
import site.sorghum.loopra.bin.session.JsonlSessionStore;
import site.sorghum.loopra.bin.tool.ToolRegistry;
import site.sorghum.loopra.bin.tool.ToolSystemInitializer.ToolSystem;
import site.sorghum.loopra.tool.AgentOutput;
import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.model.ProjectCapabilitiesDTO;

import java.io.ByteArrayOutputStream;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

class AgentServiceTurnTest {

    @TempDir Path home;
    private Path workspace;
    private String previousHome;
    private Object previousConfig;
    private Object previousSingleton;
    private AgentService service;
    private LoopraAgent agent;
    private FailingFlushStore store;
    private SessionAgentRegistry sessions;
    private final Set<String> closedProviders = new HashSet<>();
    private boolean refreshDuringChat;

    @BeforeEach
    void createRuntime() throws Exception {
        previousHome = System.getProperty("user.home");
        previousConfig = field(ConfigService.class, "config").get(null);
        previousSingleton = field(LoopraConfig.class, "INSTANCE").get(null);
        System.setProperty("user.home", home.toString());
        workspace = home.resolve("project");
        ConfigService.reload();
        ConfigService.updateConfig(Map.of("workspaceDir", workspace.toString()));
        LoopraConfig config = ConfigService.getConfig();
        service = new AgentService();
        sessions = (SessionAgentRegistry) field(AgentService.class, "sessionCache").get(service);
        Object monitor = field(AgentService.class, "runtimeMonitor").get(service);
        field(AgentService.class, "projectCapabilitiesService").set(service,
                new ProjectCapabilitiesService(monitor, sessions, root -> Set.of(),
                        root -> new ProjectCapabilitiesDTO(root.toString(), null, false, null, false,
                                List.of(), List.of()), closedProviders::add));
        ToolRegistry tools = new ToolRegistry().setDisabledTools(Set.of());
        tools.setEnvironment(SessionEnvironment.local(workspace));
        store = new FailingFlushStore(home.resolve("sessions"));
        TestLoopraProvider provider = TestLoopraProvider.builder()
                .model(config.model()).channelId(config.activeModelChannel().id())
                .call(request -> { onModelCall(); return TestLoopraProvider.response("done"); })
                .stream(request -> { onModelCall(); return TestLoopraProvider.contentStream("done"); })
                .build();
        agent = LoopraAgent.builder().config(config).environment(SessionEnvironment.local(workspace))
                .modelProvider(provider).sessionStore(store)
                .toolSystem(new ToolSystem(tools, new PromptPrefix("test", tools.toOpenAiTools())))
                .hitl("auto").buildLightweight();
        agent.bindSession("default");
        agent.setOutput(AgentOutput.NOOP);
        sessions.put(key(), agent);
    }

    @AfterEach
    void releaseRuntime() throws Exception {
        store.failFlush = false;
        service.close();
        // A refreshed Agent may already have been removed from the registry.
        agent.dispose();
        store.shutdown();
        LoopraModelProvider.CURRENT_LOG_SESSION.remove();
        System.setProperty("user.home", previousHome);
        field(ConfigService.class, "config").set(null, previousConfig);
        field(LoopraConfig.class, "INSTANCE").set(null, previousSingleton);
    }

    @Test
    void synchronousChatResolvesDefaultProjectAndPersistsTurnTiming() throws Exception {
        assertEquals("done", service.chat(UserMessage.of("hello"), null, null));
        assertTurnReleased();
        ChatMessage reply = store.load().stream().filter(ChatMessage::isAssistant).findFirst().orElseThrow();
        assertNotNull(reply.getTurnStartedAt());
        assertNotNull(reply.getElapsedMs());
    }

    @Test
    void scheduledTaskAppliesDeferredRefreshAfterReleasingItsSession() throws Exception {
        refreshDuringChat = true;
        assertEquals("done", service.executeScheduledTask(null, null, "scheduled"));
        assertEquals(Set.of(workspace.toString()), closedProviders);
        assertNull(sessions.peek(key()));
        assertTurnReleased();
    }

    @Test
    void requirementExecutionAlsoAppliesDeferredRefresh() throws Exception {
        refreshDuringChat = true;
        assertEquals("done", service.executeRequirement(null, null, "requirement", "implement", true,
                null, null, null, "auto"));
        assertEquals(Set.of(workspace.toString()), closedProviders);
        assertNull(sessions.peek(key()));
        assertTurnReleased();
    }

    @Test
    void streamingTaskKeepsRefreshPendingUntilRequestUnregisters() throws Exception {
        refreshDuringChat = true;
        service.registerSessionTask(null, null, "stream-request");
        ContextEmpty context = new ContextEmpty();
        SseEmitter emitter = new SseEmitter(context);
        service.chatStream(UserMessage.of("stream"), null, null, emitter,
                null, null, null, null, null, null);

        assertTrue(emitter.isCompleted());
        assertTrue(body(context).contains("event: complete"));
        assertTrue(body(context).contains("event: done"));
        assertTrue(closedProviders.isEmpty());
        assertSame(agent, sessions.peek(key()));
        assertTurnReleased();
        service.unregisterSessionTask(null, null, "stream-request");
        assertEquals(Set.of(workspace.toString()), closedProviders);
        assertNull(sessions.peek(key()));
    }

    @Test
    void streamingCleanupFailureStillSendsErrorCompletesAndUnlocks() throws Exception {
        ContextEmpty context = new ContextEmpty();
        SseEmitter emitter = new SseEmitter(context);
        store.failFlush = true;
        service.chatStream(UserMessage.of("hello"), null, null, emitter,
                null, null, null, null, "unknown-action", null);

        assertTrue(emitter.isCompleted());
        assertTrue(body(context).contains("event: error"));
        assertTrue(body(context).contains("event: done"));
        assertTrue(body(context).contains("不支持的聊天操作"));
        assertTrue(store.saveAttempted, "flush failure must not skip usage persistence");
        assertTurnReleased();
    }

    @Test
    void scheduledCleanupFailureReturnsAnErrorWithoutLeakingThreadContext() throws Exception {
        store.failFlush = true;
        assertTrue(service.executeScheduledTask(null, null, "scheduled").startsWith("错误："));
        assertTrue(store.saveAttempted);
        assertTurnReleased();
    }

    @Test
    void missingRequirementApprovalReleasesScopeWithoutBindingAnAgent() throws Exception {
        assertThrows(ServiceException.class, () -> service.resolveRequirementApproval(null, null, true));
        assertTurnReleased();
    }

    @Test
    void invalidTurnWorkspaceStillReportsAnErrorAndCompletesTheStream() throws Exception {
        ContextEmpty context = new ContextEmpty();
        SseEmitter emitter = new SseEmitter(context);
        service.chatStream(UserMessage.of("hello"), "invalid\0workspace", "session", emitter,
                null, null, null, null, null, null);

        assertTrue(emitter.isCompleted());
        assertTrue(body(context).contains("event: error"));
        assertNull(LoopraModelProvider.CURRENT_LOG_SESSION.get());
        assertFalse(sessions.getLock("invalid\0workspace::session").isLocked());
    }

    @Test
    void planExecutionConsumesThePlanAndKeepsMessageMetadata() throws Exception {
        AgentLoop loop = (AgentLoop) field(LoopraAgent.class, "loop").get(agent);
        agent.setPlanMode(true);
        loop.submitPlan("inspect then implement");
        UserMessage message = UserMessage.of("approved");
        message.setRollbackId("rollback-1");
        message.setSnapshotId("snapshot-1");
        ContextEmpty context = new ContextEmpty();
        SseEmitter emitter = new SseEmitter(context);

        service.chatStream(message, null, null, emitter,
                null, null, null, null, "execute_plan", "linked project context");

        assertNull(agent.getPendingPlan());
        assertFalse(agent.isPlanMode());
        ChatMessage instruction = agent.getCtx().getHistory().stream()
                .filter(item -> "rollback-1".equals(item.getRollbackId())).findFirst().orElseThrow();
        assertTrue(instruction.isWebHidden());
        assertEquals("snapshot-1", instruction.getSnapshotId());
        assertTrue(instruction.getContent().contains("inspect then implement"));
        assertTrue(body(context).contains("event: complete"));
        assertTurnReleased();
    }

    @Test
    void planFailureBeforeExecutionRestoresThePlanAndRemovesInjectedContext() throws Exception {
        AgentLoop loop = (AgentLoop) field(LoopraAgent.class, "loop").get(agent);
        agent.setPlanMode(true);
        loop.submitPlan("keep this plan");
        agent.getCtx().injectHistory(ChatMessage.ofUser("existing history"));
        int before = agent.historySize();
        // Fail before the loop can add any execution output.
        Object engine = field(AgentLoop.class, "cutinEngine").get(loop);
        field(AgentLoop.class, "cutinEngine").set(loop, null);
        ContextEmpty context = new ContextEmpty();
        SseEmitter emitter = new SseEmitter(context);

        try {
            service.chatStream(UserMessage.of("approved"), null, null, emitter,
                    null, null, null, null, "execute_plan", "temporary linked context");
        } finally {
            field(AgentLoop.class, "cutinEngine").set(loop, engine);
        }

        assertEquals("keep this plan", agent.getPendingPlan());
        assertTrue(agent.isPlanMode());
        assertEquals(before, agent.historySize());
        assertEquals("existing history", agent.getCtx().getHistory().get(before - 1).getContent());
        assertTrue(body(context).contains("event: error"));
        assertTrue(emitter.isCompleted());
        assertTurnReleased();
    }

    private void onModelCall() {
        // Cutin runs model calls on a worker; the caller owns the session lock.
        assertTrue(sessions.getLock(key()).isLocked());
        if (refreshDuringChat) service.requestProjectMcpRefresh(workspace.toString());
    }

    private void assertTurnReleased() throws Exception {
        assertFalse(sessions.getLock(key()).isLocked());
        assertNull(LoopraModelProvider.CURRENT_LOG_SESSION.get());
        AgentLoop loop = (AgentLoop) field(LoopraAgent.class, "loop").get(agent);
        assertSame(AgentOutput.NOOP, loop.getOutput());
    }

    private String key() { return workspace + "::default"; }

    private static String body(ContextEmpty context) throws Exception {
        return ((ByteArrayOutputStream) context.outputStream()).toString(StandardCharsets.UTF_8);
    }

    private static Field field(Class<?> type, String name) throws Exception {
        Field field = type.getDeclaredField(name);
        field.setAccessible(true);
        return field;
    }

    private static final class FailingFlushStore extends JsonlSessionStore {
        private boolean failFlush;
        private boolean saveAttempted;

        FailingFlushStore(Path path) { super(path); }

        @Override
        public void flush() {
            if (failFlush) throw new IllegalStateException("flush failed");
            super.flush();
        }

        @Override
        public void saveUsage(String name, long prompt, long completion, long hit, long miss, long lastPrompt)
                throws java.io.IOException {
            saveAttempted = true;
            super.saveUsage(name, prompt, completion, hit, miss, lastPrompt);
        }
    }
}
