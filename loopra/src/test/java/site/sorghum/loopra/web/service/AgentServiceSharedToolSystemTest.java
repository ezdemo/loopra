package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import site.sorghum.loopra.bin.agent.environment.SessionEnvironment;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.loopra.bin.agent.core.AgentLoop;
import site.sorghum.loopra.bin.agent.core.LoopraAgent;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.config.ConfigService;
import site.sorghum.loopra.bin.tool.ToolSystemInitializer;
import site.sorghum.loopra.web.model.SessionSettingsDTO;
import site.sorghum.cutin.core.plugin.PluginBeanManager;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.file.Path;
import java.util.Map;

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

    private static LoopraAgent getOrCreateAgent(AgentService service, Path workspace, String sessionName) throws Exception {
        Method keyMethod = AgentService.class.getDeclaredMethod("generateSessionKey", String.class, String.class);
        keyMethod.setAccessible(true);
        String key = (String) keyMethod.invoke(service, workspace.toString(), sessionName);
        Method agentMethod = AgentService.class.getDeclaredMethod("getOrCreateAgent", String.class);
        agentMethod.setAccessible(true);
        return (LoopraAgent) agentMethod.invoke(service, key);
    }

    private static AgentLoop loopOf(LoopraAgent agent) throws Exception {
        Field field = LoopraAgent.class.getDeclaredField("loop");
        field.setAccessible(true);
        return (AgentLoop) field.get(agent);
    }

    private static boolean hasPlanExecutionStarted(AgentService service, LoopraAgent agent) throws Exception {
        Method method = AgentService.class.getDeclaredMethod("hasPlanExecutionStarted", LoopraAgent.class);
        method.setAccessible(true);
        return (boolean) method.invoke(service, agent);
    }

    private static ToolSystemInitializer.ToolSystem getOrCreate(AgentService service, Path workspace) throws Exception {
        Method method = AgentService.class.getDeclaredMethod("getOrCreateSharedToolSystem", SessionEnvironment.class);
        method.setAccessible(true);
        return (ToolSystemInitializer.ToolSystem) method.invoke(
                service, SessionEnvironment.of(workspace, null));
    }
}
