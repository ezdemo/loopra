package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.loopra.bin.agent.core.LoopraAgent;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.config.ConfigService;
import site.sorghum.loopra.bin.config.LoopraConfig;
import site.sorghum.loopra.bin.project.ProjectRegistry;
import site.sorghum.loopra.bin.session.JsonlSessionStore;
import site.sorghum.loopra.bin.session.SessionStore;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class SessionHistoryReadTest {
    @TempDir Path home;
    private String previousHome;
    private Object previousConfig;
    private Object previousSingleton;
    private AgentService service;
    private Path project;

    @BeforeEach
    void isolate() throws Exception {
        previousHome = System.getProperty("user.home");
        previousConfig = field(ConfigService.class, "config").get(null);
        previousSingleton = field(LoopraConfig.class, "INSTANCE").get(null);
        System.setProperty("user.home", home.toString());
        ConfigService.reload();
        project = Files.createDirectories(home.resolve("project"));
        ProjectRegistry.getOrCreate(project.toString());
        service = new AgentService();
    }

    @AfterEach
    void restore() throws Exception {
        if (service != null) service.close();
        System.setProperty("user.home", previousHome);
        field(ConfigService.class, "config").set(null, previousConfig);
        field(LoopraConfig.class, "INSTANCE").set(null, previousSingleton);
    }

    @Test
    void coldNativeAndExternalHistoryReadWithoutInitializingAgentsOrWorktrees() throws Exception {
        JsonlSessionStore store = new JsonlSessionStore(new ProjectRegistry().getSessionsDir(project.toString()));
        try {
            for (String name : List.of("native", "external")) {
                store.bindTo(name);
                store.append(ChatMessage.ofUser("history of " + name));
            }
            // No Git repository or Solon runtime exists: browsing must never try to create a worktree.
            store.setWorktreeMode("native", true);
            store.setAcpBinding("external", new SessionStore.AcpBinding("codex", null, null));
        } finally { store.shutdown(); }

        for (String name : List.of("native", "external")) {
            assertEquals(List.of("history of " + name), service.getHistory(project.toString(), name)
                    .stream().map(ChatMessage::getContent).toList());
            assertEquals(0, service.getCacheSize());
            assertNull(service.peekAgent(project.toString(), name));
        }
        assertTrue(((Map<?, ?>) field(AgentService.class, "sharedToolSystems").get(service)).isEmpty());
        assertTrue(service.getHistory(project.toString(), "missing").isEmpty());
        assertEquals(0, service.getCacheSize());
    }

    @Test
    void readingAnActiveSessionKeepsItsAgentAndStoreUsable() throws Exception {
        var create = AgentService.class.getDeclaredMethod("getOrCreateAgent", String.class);
        create.setAccessible(true);
        LoopraAgent agent = (LoopraAgent) create.invoke(service, project + "::active");
        SessionStore store = agent.getCtx().getSessionStore();
        store.append(ChatMessage.ofUser("first"));
        assertEquals("first", service.getHistory(project.toString(), "active").get(0).getContent());
        store.append(ChatMessage.ofUser("second"));
        assertEquals(2, service.getHistory(project.toString(), "active").size());
        assertSame(agent, service.peekAgent(project.toString(), "active"));
        assertEquals(1, service.getCacheSize());
    }

    private static Field field(Class<?> owner, String name) throws Exception {
        Field field = owner.getDeclaredField(name);
        field.setAccessible(true);
        return field;
    }
}
