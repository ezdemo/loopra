package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.loopra.bin.agent.core.LoopraAgent;
import site.sorghum.loopra.bin.agent.environment.SessionEnvironment;
import site.sorghum.loopra.bin.config.ConfigService;
import site.sorghum.loopra.bin.config.LoopraConfig;
import site.sorghum.loopra.bin.tool.ToolSystemInitializer.ToolSystem;
import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.model.ProjectCapabilitiesDTO;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Function;

import static org.junit.jupiter.api.Assertions.*;

class AgentServiceProjectCapabilitiesTest {

    @TempDir
    Path home;
    private Path project;
    private Path other;
    private String previousHome;
    private Object previousConfig;
    private Object previousSingleton;
    private AgentService service;

    @BeforeEach
    void isolateRuntime() throws Exception {
        previousHome = System.getProperty("user.home");
        previousConfig = field(ConfigService.class, "config").get(null);
        previousSingleton = field(LoopraConfig.class, "INSTANCE").get(null);
        System.setProperty("user.home", home.toString());
        project = Files.createDirectories(home.resolve("project"));
        other = Files.createDirectories(home.resolve("project#other"));
        ConfigService.reload();
        service = new AgentService();
    }

    @AfterEach
    void closeRuntime() throws Exception {
        if (service != null) service.close();
        System.setProperty("user.home", previousHome);
        field(ConfigService.class, "config").set(null, previousConfig);
        field(LoopraConfig.class, "INSTANCE").set(null, previousSingleton);
    }

    @Test
    void busyProjectDoesNotPartiallyDisposeAgentsAndIdleRefreshKeepsOtherProjects() throws Exception {
        LoopraAgent first = agent(project, "first");
        LoopraAgent second = agent(other, "second");
        Set<String> closedProviders = new HashSet<>();
        installCapabilities(AgentServiceProjectCapabilitiesTest::capabilities, closedProviders);
        service.registerSessionTask(project.toString(), "queued", "queued-request");

        assertThrows(ServiceException.class, () -> service.refreshProjectCapabilities(project.toString()));
        assertEquals(2, service.getCacheSize());
        assertSame(first, sessions().peek(project + "::first"));
        assertSame(second, sessions().peek(other + "::second"));
        assertTrue(closedProviders.isEmpty());

        service.unregisterSessionTask(project.toString(), "queued", "queued-request");
        service.refreshProjectCapabilities(project.toString());
        assertNull(sessions().peek(project + "::first"));
        assertSame(second, sessions().peek(other + "::second"));
        assertEquals(Set.of(project.toString()), closedProviders);
        assertNotSame(first, agent(project, "first"));
    }

    @Test
    void cacheInvalidationUsesProjectIdentityAndClosesOrphanedWorktreeProviders() throws Exception {
        SessionEnvironment local = SessionEnvironment.local(project);
        SessionEnvironment sibling = SessionEnvironment.local(other);
        Path worktree = Files.createDirectories(home.resolve("old-worktree"));
        ToolSystem original = tools(local);
        ToolSystem unrelated = tools(sibling);
        tools(SessionEnvironment.isolated(project, worktree));
        Set<String> closedProviders = new HashSet<>();
        installCapabilities(AgentServiceProjectCapabilitiesTest::capabilities, closedProviders);

        service.refreshProjectCapabilities(project.toString());

        assertNotSame(original, tools(local));
        assertSame(unrelated, tools(sibling), "a project name containing # must remain independent");
        assertEquals(Set.of(project.toString(), worktree.toString()), closedProviders);
    }

    @Test
    void aNewTaskCannotRegisterBetweenIdleCheckAndProviderReload() throws Exception {
        CountDownLatch reading = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch attemptingRegistration = new CountDownLatch(1);
        installCapabilities(root -> {
            reading.countDown();
            try {
                if (!release.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("reload timed out");
            } catch (InterruptedException exception) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(exception);
            }
            return capabilities(root);
        }, new HashSet<>());
        var executor = Executors.newFixedThreadPool(2);
        try {
            var refresh = executor.submit(() -> service.refreshProjectCapabilities(project.toString()));
            assertTrue(reading.await(5, TimeUnit.SECONDS));
            var registration = executor.submit(() -> {
                attemptingRegistration.countDown();
                service.registerSessionTask(project.toString(), "new-session", "new-request");
            });
            assertTrue(attemptingRegistration.await(5, TimeUnit.SECONDS));
            assertThrows(TimeoutException.class, () -> registration.get(100, TimeUnit.MILLISECONDS));
            assertFalse(service.getSessionStatus(project.toString(), "new-session").running());

            release.countDown();
            refresh.get(5, TimeUnit.SECONDS);
            registration.get(5, TimeUnit.SECONDS);
            assertEquals("new-request", service.getSessionStatus(project.toString(), "new-session").requestId());
        } finally {
            release.countDown();
            executor.shutdownNow();
            executor.awaitTermination(5, TimeUnit.SECONDS);
            service.unregisterSessionTask(project.toString(), "new-session", "new-request");
        }
    }

    @Test
    void startupAndSessionCreationReuseTheSameDefaultToolSystem() throws Exception {
        ConfigService.updateConfig(Map.of("apiKey", "smoke-placeholder"));
        service.init();
        SessionEnvironment environment = SessionEnvironment.local(ConfigService.getConfig().workspaceDir());
        assertSame(service.getSharedToolRegistry(), tools(environment).toolRegistry());
    }

    private void installCapabilities(Function<Path, ProjectCapabilitiesDTO> reader, Set<String> closed) throws Exception {
        Object monitor = field(AgentService.class, "runtimeMonitor").get(service);
        ProjectCapabilitiesService capabilities = new ProjectCapabilitiesService(monitor, sessions(), root -> {
            try {
                Method invalidate = AgentService.class.getDeclaredMethod("invalidateProjectToolSystems", Path.class);
                invalidate.setAccessible(true);
                @SuppressWarnings("unchecked")
                Set<Path> roots = (Set<Path>) invalidate.invoke(service, root);
                return roots;
            } catch (ReflectiveOperationException exception) {
                throw new AssertionError(exception);
            }
        }, reader, closed::add);
        field(AgentService.class, "projectCapabilitiesService").set(service, capabilities);
    }

    private SessionAgentRegistry sessions() throws Exception {
        return (SessionAgentRegistry) field(AgentService.class, "sessionCache").get(service);
    }

    private LoopraAgent agent(Path projectRoot, String name) throws Exception {
        Method create = AgentService.class.getDeclaredMethod("getOrCreateAgent", String.class);
        create.setAccessible(true);
        return (LoopraAgent) create.invoke(service, projectRoot + "::" + name);
    }

    private ToolSystem tools(SessionEnvironment environment) throws Exception {
        Method create = AgentService.class.getDeclaredMethod("getOrCreateSharedToolSystem", SessionEnvironment.class);
        create.setAccessible(true);
        return (ToolSystem) create.invoke(service, environment);
    }

    private static Field field(Class<?> type, String name) throws Exception {
        Field field = type.getDeclaredField(name);
        field.setAccessible(true);
        return field;
    }

    private static ProjectCapabilitiesDTO capabilities(Path root) {
        return new ProjectCapabilitiesDTO(root.toString(), null, false, null, false, List.of(), List.of());
    }
}
