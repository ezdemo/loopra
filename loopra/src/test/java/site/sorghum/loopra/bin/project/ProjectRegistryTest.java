package site.sorghum.loopra.bin.project;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.loopra.bin.session.JsonlSessionStore;
import site.sorghum.loopra.bin.agent.model.ChatMessage;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

class ProjectRegistryTest {
    @TempDir
    Path projects;

    @Test
    void defaultRegistryAndSessionStoresUseIsolatedHome() throws Exception {
        String isolated = System.getProperty("loopra.test.home");
        assertNotNull(isolated, "Test home must be installed before static stores initialize");
        Path home = Path.of(isolated);
        ProjectRegistry registry = ProjectRegistry.getOrCreate(projects.toString());
        assertEquals(home.resolve(".loopra/workspace")
                .resolve(ProjectRegistry.computeProjectHash(projects.toString())), registry.getProjectDir(projects.toString()));
        assertTrue(Files.exists(registry.getProjectConfigPath(projects.toString())));
        assertTrue(registry.listProjects().stream().anyMatch(project -> project.path().equals(projects.toString())));

        // Also cover stores without a project, which the old JUnit-name filter missed.
        JsonlSessionStore store = new JsonlSessionStore();
        try {
            store.bindTo("isolation-probe");
            store.append(ChatMessage.ofUser("isolated test session"));
        }
        finally { store.shutdown(); }
        assertTrue(Files.exists(home.resolve(".loopra/sessions/isolation-probe.jsonl")));
    }

    @Test
    void sameNamedProjectsHaveSeparateMetadataAndSessions() throws Exception {
        Path first = Files.createDirectories(projects.resolve("one/project"));
        Path second = Files.createDirectories(projects.resolve("two/project"));
        ProjectRegistry registry = ProjectRegistry.getOrCreate(first.toString());
        ProjectRegistry.getOrCreate(second.toString());
        assertNotEquals(registry.getSessionsDir(first.toString()), registry.getSessionsDir(second.toString()));
        assertEquals(2, registry.listProjects().stream()
                .filter(project -> project.path().equals(first.toString()) || project.path().equals(second.toString())).count());
    }
}
