package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.noear.solon.ai.chat.tool.FunctionToolDesc;
import site.sorghum.cutin.core.plugin.PluginBeanManager;
import site.sorghum.loopra.bin.agent.core.AgentLoop;
import site.sorghum.loopra.bin.agent.core.LoopraAgent;
import site.sorghum.loopra.bin.agent.environment.ChatMode;
import site.sorghum.loopra.bin.agent.environment.SessionEnvironment;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.bin.command.ChatCommand;
import site.sorghum.loopra.bin.command.ChatCommandContext;
import site.sorghum.loopra.bin.command.ChatCommandRegistry;
import site.sorghum.loopra.bin.command.MessageWrapper;
import site.sorghum.loopra.bin.config.ConfigService;
import site.sorghum.loopra.bin.project.ProjectRegistry;
import site.sorghum.loopra.bin.session.JsonlSessionStore;
import site.sorghum.loopra.bin.session.SessionStore;
import site.sorghum.loopra.bin.session.SessionStore.SessionModelSettings;
import site.sorghum.loopra.bin.tool.ToolSystemInitializer;
import site.sorghum.loopra.tool.AgentOutput;
import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.model.SessionSettingsDTO;

import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 共享工具系统缓存回归测试。
 * <p>
 * 复现并守护 listSessions → createAgent → getOrCreateSharedToolSystem 路径：
 * {@code computeIfAbsent} 的映射函数曾递归 {@code put} 同一 Map，
 * 触发 {@code IllegalStateException: Recursive update}。
 * </p>
 *
 * @author Sorghum
 */
class AgentServiceSharedToolSystemTest {

    @TempDir
    Path home;
    @TempDir
    Path workspaceA;
    @TempDir
    Path workspaceB;

    private String originalUserHome;

    @BeforeEach
    void isolateUserHomeAndConfig() {
        originalUserHome = System.getProperty("user.home");
        System.setProperty("user.home", home.toString());
        // AgentService 脱离 Solon 容器实例化时，静态配置需先行就绪
        ConfigService.reload();
    }

    @AfterEach
    void restoreUserHome() {
        System.setProperty("user.home", originalUserHome);
    }

    @Test
    void firstAccessBuildsWithoutRecursiveUpdateAndReusesOnSecondAccess() throws Exception {
        AgentService service = new AgentService();

        // 修复前：首次访问即抛 IllegalStateException: Recursive update
        ToolSystemInitializer.ToolSystem first = getOrCreate(service, workspaceA);
        ToolSystemInitializer.ToolSystem second = getOrCreate(service, workspaceA);

        assertNotNull(first);
        assertSame(first, second, "同一项目第二次访问应复用缓存");
    }

    @Test
    void differentWorkspacesGetIndependentToolSystems() throws Exception {
        AgentService service = new AgentService();

        ToolSystemInitializer.ToolSystem a = getOrCreate(service, workspaceA);
        ToolSystemInitializer.ToolSystem b = getOrCreate(service, workspaceB);

        assertNotSame(a, b, "不同项目应各自构建独立的工具系统");
    }

    @Test
    void sessionStatusUsesActiveTaskRegistrationAndKeepsSessionsIsolated() {
        AgentService service = new AgentService();
        String sessionName = "running-session";
        String taskA = "task-a";
        String taskB = "task-b";

        service.registerSessionTask(workspaceA.toString(), sessionName, taskA);
        assertTrue(service.getSessionStatus(workspaceA.toString(), sessionName).running());
        assertEquals(taskA, service.getSessionStatus(workspaceA.toString(), sessionName).requestId());
        assertFalse(service.getSessionStatus(workspaceB.toString(), sessionName).running(),
                "不同项目的同名会话不能共享运行状态");

        service.registerSessionTask(workspaceA.toString(), sessionName, taskB);
        service.unregisterSessionTask(workspaceA.toString(), sessionName, taskA);
        assertTrue(service.getSessionStatus(workspaceA.toString(), sessionName).running(),
                "清理旧任务不能清除同一会话的新任务");
        assertEquals(taskB, service.getSessionStatus(workspaceA.toString(), sessionName).requestId());

        service.unregisterSessionTask(workspaceA.toString(), sessionName, taskB);
        assertFalse(service.getSessionStatus(workspaceA.toString(), sessionName).running());
    }

    @Test
    void sessionStatusIncludesTheStoredTitleWithoutCreatingAnAgent() throws Exception {
        AgentService service = new AgentService();
        String name = "generated-title";
        service.newSession(workspaceA.toString(), name, false);
        service.renameSession(workspaceA.toString(), name, "Generated title");
        var status = service.getSessionStatus(workspaceA.toString(), name);
        assertEquals("Generated title", status.title());
        assertFalse(status.running());
        assertNull(service.peekAgent(workspaceA.toString(), name));
        assertNull(service.getSessionStatus(workspaceB.toString(), name).title());
    }

    @Test
    void sessionStatusDoesNotInferRunningFromHistory() throws Exception {
        AgentService service = new AgentService();
        String sessionName = "history-only";
        getOrCreateAgent(service, workspaceA, sessionName);

        assertFalse(service.getSessionStatus(workspaceA.toString(), sessionName).running(),
                "仅存在历史和缓存 Agent 时不应报告运行中");
    }

    @Test
    void sessionModelSettingsRemainWhenGlobalDefaultsChange() {
        AgentService service = new AgentService();
        String channelId = ConfigService.getConfig().activeModelChannel().id();

        service.updateSessionSettings(workspaceA.toString(), "fixed-session",
                "session-model", channelId, "low");
        ConfigService.updateConfig(Map.of("model", "global-model", "reasoningEffort", "high"));

        SessionSettingsDTO settings = service.getSessionSettings(workspaceA.toString(), "fixed-session");
        assertEquals("session-model", settings.model());
        assertEquals(channelId, settings.modelChannelId());
        assertEquals("low", settings.reasoningEffort());
    }

    @Test
    void planExecutionStartRequiresSubstantiveModelOutput() throws Exception {
        AgentService service = new AgentService();
        LoopraAgent agent = getOrCreateAgent(service, workspaceA, "plan-start-detection");
        ChatMessage hidden = ChatMessage.ofUser("internal execution instruction");
        hidden.setWebHidden(true);
        agent.getCtx().injectHistory(hidden);
        agent.getCtx().injectHistory(ChatMessage.assistant("", null, null));

        assertFalse(hasPlanExecutionStarted(service, agent));

        agent.getCtx().injectHistory(ChatMessage.assistant("execution started", null, null));
        assertTrue(hasPlanExecutionStarted(service, agent));
    }

    @Test
    void truncateHistoryClearsPendingPlan() throws Exception {
        AgentService service = new AgentService();
        String sessionName = "rollback-plan";
        LoopraAgent agent = getOrCreateAgent(service, workspaceA, sessionName);
        ChatMessage user = ChatMessage.ofUser("plan task");
        user.setRollbackId("rollback-1");
        agent.getCtx().injectHistory(user);
        loopOf(agent).submitPlan("1. inspect\n2. implement");
        assertNotNull(loopOf(agent).getPendingPlan());

        String rollbackText = service.truncateHistoryBySnapshotId(
                workspaceA.toString(), sessionName, "rollback-1", null);

        assertEquals("plan task", rollbackText);
        assertNull(loopOf(agent).getPendingPlan());
        assertNull(agent.getCtx().getSessionStore().getPendingPlan(sessionName));
    }

    @Test
    void evictionAndShutdownReleaseAgentPlugins() throws Exception {
        AgentService service = new AgentService();
        for (String operation : new String[]{"one", "all", "shutdown"}) {
            LoopraAgent agent = getOrCreateAgent(service, workspaceA, operation);
            Field pluginsField = AgentLoop.class.getDeclaredField("cutinPlugins");
            pluginsField.setAccessible(true);
            PluginBeanManager plugins = (PluginBeanManager) pluginsField.get(loopOf(agent));
            assertTrue(plugins.pluginStates().stream().anyMatch(state -> state.active()));

            switch (operation) {
                case "one" -> service.evictAgent(workspaceA.toString(), operation);
                case "all" -> service.evictAllAgents();
                default -> service.close();
            }

            assertEquals(0, service.getCacheSize());
            assertTrue(plugins.pluginStates().stream().noneMatch(state -> state.active()), operation);
        }
    }

    @Test
    void factoryKeepsSelectedChannelAndIsolatedRootsWhileReusingTools() throws Exception {
        ConfigService.updateConfig(Map.of(
                "model", "global-model", "modelChannelId", "main", "modelChannels", List.of(
                        Map.of("id", "main", "models", List.of("global-model")),
                        Map.of("id", "secondary", "baseUrl", "https://secondary.test/v1",
                                "apiKey", "test-key", "apiProtocol", "responses",
                                "specialCompatibility", "opencode", "models", List.of(
                                        Map.of("name", "chosen-model", "maxTokens", 4096))))));
        SessionEnvironment environment = SessionEnvironment.isolated(workspaceA, workspaceB);
        var tools = ToolSystemInitializer.initializePluginized(environment, null);
        AtomicReference<SessionEnvironment> toolEnvironment = new AtomicReference<>();
        SessionAgentFactory factory = new SessionAgentFactory(() -> null,
                (workspace, session) -> {
                    assertEquals(workspaceA.toString(), workspace);
                    assertEquals("chosen-session", session);
                    return environment;
                }, resolved -> {
                    toolEnvironment.set(resolved);
                    return tools;
                });

        LoopraAgent agent = factory.create(workspaceA.toString(), "chosen-session",
                new SessionModelSettings("chosen-model", "secondary", "low"), null, ConfigService.getConfig());
        try {
            assertSame(environment, agent.getEnvironment());
            assertSame(environment, toolEnvironment.get());
            assertSame(tools.toolRegistry(), loopOf(agent).getToolRegistry());
            assertEquals("chosen-session", agent.getCtx().getSessionStore().currentName());
            assertSame(AgentOutput.NOOP, agent.getOutput());
            var provider = loopOf(agent).getModelProvider();
            assertEquals("chosen-model", provider.getModel());
            assertEquals("secondary", provider.getModelChannelId());
            assertEquals("low", provider.getReasoningEffort());
            assertEquals("https://secondary.test/v1/responses", provider.apiUrl());
            assertEquals("opencode", provider.getSpecialCompatibility());
            assertEquals(4096, provider.getMaxTokens());
        } finally {
            agent.dispose();
        }
    }

    @Test
    void factoryRejectsUnknownChannelBeforeCreatingWorkspaceOrTools() {
        SessionAgentFactory factory = new SessionAgentFactory(() -> {
            fail("commands must not be accessed");
            return null;
        }, (workspace, session) -> {
            fail("workspace must not be created");
            return null;
        }, environment -> {
            fail("tools must not be initialized");
            return null;
        });

        ServiceException error = assertThrows(ServiceException.class, () -> factory.create(
                workspaceA.toString(), "session", new SessionModelSettings("model", "missing", "low"),
                null, ConfigService.getConfig()));
        assertEquals(400, error.getCode());
    }

    @Test
    void pureChatKeepsOnlyNetworkFacingToolsAndUsesItsOwnPrompt() throws Exception {
        configureModelChannels();
        Path chatRoot = ChatMode.root();
        assertFalse(Files.exists(chatRoot));
        SessionEnvironment environment = SessionEnvironment.local(chatRoot);
        ToolSystemInitializer.ToolSystem tools = ToolSystemInitializer.initializePluginized(environment, null);
        SessionAgentFactory factory = new SessionAgentFactory(() -> null,
                (workspace, session) -> environment,
                resolved -> tools);

        LoopraAgent agent = factory.create(chatRoot.toString(), "chat-session",
                new SessionModelSettings("first-model", "main", "low"), null, ConfigService.getConfig());
        try {
            tools.toolRegistry().register(tool("read"));
            tools.toolRegistry().register(tool("webfetch"));
            tools.toolRegistry().register(tool("websearch"));
            tools.toolRegistry().register(tool("bash"));

            assertFalse(tools.toolRegistry().isEnabled("read"));
            assertFalse(tools.toolRegistry().isEnabled("bash"));
            assertTrue(tools.toolRegistry().isEnabled("webfetch"));
            assertTrue(tools.toolRegistry().isEnabled("websearch"));
            assertTrue(loopOf(agent).effectiveSystemPrompt().contains("纯聊天"));
            assertEquals(chatRoot.toString(),
                    new ProjectCatalog(java.util.Set::of).resolveProjectPath(ChatMode.WORKSPACE_HASH));

            var external = new com.agentclientprotocol.sdk.spec.AcpSchema.McpServerStdio(
                    "codegraph", "must-not-start-pure-chat-mcp", List.of("serve", "--mcp"), List.of());
            agent.setAcpMcpServers(List.of(external));
            assertTrue(agent.getAcpMcpServers().isEmpty());
            assertTrue(loopOf(agent).getToolRegistry().sessionTools().isEmpty());
            agent.refreshTools();
            assertTrue(loopOf(agent).getToolRegistry().isEnabled("websearch"));
            assertFalse(loopOf(agent).getToolRegistry().isEnabled("bash"));
            assertThrows(IllegalStateException.class, () -> agent.setPlanMode(true));
            assertFalse(loopOf(agent).isPlanMode());
        } finally {
            agent.dispose();
        }
    }

    @Test
    void changingModelWithinAChannelKeepsTheAgentAndUpdatesItsLimits() throws Exception {
        configureModelChannels();
        AgentService service = new AgentService();
        try {
            service.updateSessionSettings(workspaceA.toString(), "switch", "first-model", "main", "low");
            LoopraAgent original = getOrCreateAgent(service, workspaceA, "switch");
            original.getCtx().injectHistory(ChatMessage.ofUser("keep this conversation"));

            service.updateSessionSettings(workspaceA.toString(), "switch", "second-model", "main", "high");
            LoopraAgent updated = getOrCreateAgent(service, workspaceA, "switch");

            assertSame(original, updated);
            assertEquals("second-model", updated.getModel());
            assertEquals("high", updated.getReasoningEffort());
            assertEquals(8192, loopOf(updated).getModelProvider().getMaxTokens());
            assertTrue(updated.getCtx().getHistory().stream()
                    .anyMatch(message -> "keep this conversation".equals(message.getContent())));
        } finally {
            service.close();
        }
    }

    @Test
    void failedChannelRebuildDoesNotLeaveADisposedAgentInCacheAndCanRecover() throws Exception {
        configureModelChannels();
        AtomicBoolean failEnvironment = new AtomicBoolean();
        AgentService service = new AgentService() {
            @Override
            public boolean isSessionWorktreeMode(String workspace, String session) {
                if (failEnvironment.get()) throw new IllegalStateException("environment unavailable");
                return false;
            }
        };
        try {
            service.updateSessionSettings(workspaceA.toString(), "switch", "first-model", "main", "low");
            LoopraAgent original = getOrCreateAgent(service, workspaceA, "switch");
            original.getCtx().getSessionStore().append(ChatMessage.ofUser("persisted conversation"));

            service.updateSessionSettings(workspaceA.toString(), "switch", "other-model", "secondary", "high");
            failEnvironment.set(true);
            InvocationTargetException error = assertThrows(InvocationTargetException.class,
                    () -> getOrCreateAgent(service, workspaceA, "switch"));
            assertInstanceOf(IllegalStateException.class, error.getCause());
            assertEquals(0, service.getCacheSize());

            failEnvironment.set(false);
            LoopraAgent recovered = getOrCreateAgent(service, workspaceA, "switch");
            assertNotSame(original, recovered);
            assertEquals("secondary", recovered.getModelChannelId());
            assertEquals("other-model", recovered.getModel());
            assertTrue(recovered.getCtx().getHistory().stream()
                    .anyMatch(message -> "persisted conversation".equals(message.getContent())));
        } finally {
            service.close();
        }
    }

    @Test
    void pureChatRejectsProjectCommandsBeforeExecutionAndKeepsChatCommands() throws Exception {
        configureModelChannels();
        var executed = new ArrayList<String>();
        var commands = new ChatCommandRegistry();
        var registered = new ArrayList<ChatCommand>();
        for (String name : List.of("plugin", "init", "goal", "plan", "compact")) {
            registered.add(new ChatCommand() {
                public String getCommand() { return name; }
                public String getDescription() { return "/" + name + " test"; }
                public boolean matches(String input) { return input.startsWith("/" + name); }
                public CommandResult execute(MessageWrapper input, ChatCommandContext context) {
                    executed.add(name);
                    return CommandResult.CONTINUE;
                }
            });
        }
        Field field = commands.getClass().getDeclaredField("commands");
        field.setAccessible(true);
        field.set(commands, registered);
        commands.init();
        var environment = SessionEnvironment.local(ChatMode.root());
        var factory = new SessionAgentFactory(() -> commands, (workspace, session) -> environment,
                resolved -> ToolSystemInitializer.initializePluginized(environment, null));
        LoopraAgent agent = factory.create(ChatMode.root().toString(), "commands",
                new SessionModelSettings("first-model", "main", "low"), null, ConfigService.getConfig());
        try {
            for (String command : List.of("/plugin add untrusted.jar", "/init", "/goal", "/plan")) {
                IllegalStateException error = assertThrows(IllegalStateException.class, () ->
                        agent.chat(UserMessage.of(command)));
                assertTrue(error.getMessage().contains("纯聊天模式不支持"));
            }
            assertTrue(executed.isEmpty());
            agent.chat(UserMessage.of("/compact"));
            assertEquals(List.of("compact"), executed);
            assertEquals(List.of("/compact test"), commands.getHelpLines(ChatMode.ALLOWED_COMMANDS));
        } finally {
            agent.dispose();
        }
    }

    @Test
    void pureChatConfigurationRejectsProjectModesAndLegacyExternalBindings() throws Exception {
        configureModelChannels();
        AgentService service = new AgentService();
        Path chat = ChatMode.root();
        var registry = new ProjectRegistry();
        var store = new JsonlSessionStore(registry.getSessionsDir(chat.toString()));
        try {
            store.setAcpBinding("legacy", new SessionStore.AcpBinding("codex", null, null));
            store.setWorktreeMode("legacy", true);
            store.setPlanMode("legacy", true);
        } finally { store.shutdown(); }
        try {
            assertEquals("native", service.sessionAgentId(chat.toString(), "legacy"));
            assertFalse(service.isSessionWorktreeMode(chat.toString(), "legacy"));
            assertThrows(ServiceException.class, () -> service.setSessionWorktreeMode(chat.toString(), "legacy", true));
            assertThrows(ServiceException.class, () -> service.selectSessionAgent(chat.toString(), "legacy", "codex"));
            LoopraAgent agent = getOrCreateAgent(service, chat, "legacy");
            assertFalse(loopOf(agent).isPlanMode());
            assertNull(loopOf(agent).getPendingPlan());
            var options = service.agentConfiguration(chat.toString(), "legacy", null, null);
            assertTrue(options.stream().noneMatch(option -> "plan".equals(option.id())));
            Exception error = assertThrows(Exception.class, () ->
                    service.agentConfiguration(chat.toString(), "legacy", "plan", "on"));
            assertTrue(error.getMessage().contains("plan"), error.getMessage());
        } finally { service.close(); }
    }

    private static void configureModelChannels() {
        ConfigService.updateConfig(Map.of("model", "first-model", "modelChannelId", "main",
                "modelChannels", List.of(
                        Map.of("id", "main", "baseUrl", "https://main.test/v1", "models", List.of(
                                Map.of("name", "first-model", "maxTokens", 1024),
                                Map.of("name", "second-model", "maxTokens", 8192))),
                        Map.of("id", "secondary", "baseUrl", "https://secondary.test/v1",
                                "models", List.of("other-model")))));
    }

    private static LoopraAgent getOrCreateAgent(AgentService service, Path workspace, String sessionName) throws Exception {
        Method keyMethod = AgentService.class.getDeclaredMethod("generateSessionKey", String.class, String.class);
        keyMethod.setAccessible(true);
        String key = (String) keyMethod.invoke(service, workspace.toString(), sessionName);
        Method agentMethod = AgentService.class.getDeclaredMethod("getOrCreateAgent", String.class);
        agentMethod.setAccessible(true);
        return (LoopraAgent) agentMethod.invoke(service, key);
    }

    private static FunctionToolDesc tool(String name) {
        return new FunctionToolDesc(name)
                .description(name)
                .inputSchema("{\"type\":\"object\"}")
                .returnType(String.class)
                .doHandle(args -> "ok");
    }

    private static AgentLoop loopOf(LoopraAgent agent) throws Exception {
        Field field = LoopraAgent.class.getDeclaredField("loop");
        field.setAccessible(true);
        return (AgentLoop) field.get(agent);
    }

    private static boolean hasPlanExecutionStarted(AgentService service, LoopraAgent agent) throws Exception {
        return SessionTurn.hasPlanExecutionStarted(agent);
    }

    private static ToolSystemInitializer.ToolSystem getOrCreate(AgentService service, Path workspace) throws Exception {
        Method method = AgentService.class.getDeclaredMethod("getOrCreateSharedToolSystem", SessionEnvironment.class);
        method.setAccessible(true);
        return (ToolSystemInitializer.ToolSystem) method.invoke(
                service, SessionEnvironment.of(workspace, null));
    }
}
