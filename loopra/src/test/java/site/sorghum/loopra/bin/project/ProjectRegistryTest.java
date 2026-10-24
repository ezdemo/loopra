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
    void directLookupReadsTheLatestRegistrationWithoutListingOtherProjects() throws Exception {
        Path project = Files.createDirectories(projects.resolve("lookup"));
        ProjectRegistry registry = ProjectRegistry.getOrCreate(project.toString());
        String hash = ProjectRegistry.computeProjectHash(project.toString());
        ProjectRegistry lookup = new ProjectRegistry() {
            @Override public java.util.List<ProjectInfo> listProjects() {
                throw new AssertionError("Direct lookup must not enumerate the catalog");
            }
        };
        assertEquals(project.toString(), lookup.findProjectPath(hash));
        Files.delete(registry.getProjectConfigPath(project.toString()));
        assertNull(lookup.findProjectPath(hash), "Deleted registrations must not remain in a path cache");
    }

    @Test
    void directLookupRejectsTraversalAndReadsUpdatedRegistrationPaths() throws Exception {
        ProjectRegistry registry = ProjectRegistry.getOrCreate(projects.toString());
        for (String hash : new String[]{"../escape", "..\\escape", "", "000000000000", "invalid"}) {
            assertNull(registry.findProjectPath(hash));
        }
        assertNull(registry.findProjectPath(null));
        Path metadata = registry.getProjectConfigPath(projects.toString());
        Files.writeString(metadata, "{\"path\":\"different-project\"}");
        assertEquals("different-project", registry.findProjectPath(ProjectRegistry.computeProjectHash(projects.toString())));
        Files.writeString(metadata, "{\"path\":\" \"}");
        assertNull(registry.findProjectPath(ProjectRegistry.computeProjectHash(projects.toString())));
    }

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

    @Test
    void displayNamesPersistAcrossLoadsAndDoNotChangePathsOrSessions() throws Exception {
        Path project = Files.createDirectories(projects.resolve("service"));
        ProjectRegistry registry = ProjectRegistry.getOrCreate(project.toString());
        String hash = ProjectRegistry.computeProjectHash(project.toString());
        Path session = registry.getSessionsDir(project.toString()).resolve("conversation.jsonl");
        Files.writeString(session, "saved conversation");
        String originalMetadata = Files.readString(registry.getProjectConfigPath(project.toString()));
        registry.renameProject(hash, "  核心服务  ");
        registry.updateLastAccessed(project.toString());
        var info = new ProjectRegistry().listProjects().stream().filter(item -> item.hash().equals(hash)).findFirst().orElseThrow();
        assertEquals("核心服务", info.name());
        assertEquals("核心服务", info.displayName());
        assertEquals(project.toString(), info.path());
        assertEquals(1, info.sessionCount());
        assertEquals("saved conversation", Files.readString(session));
        assertEquals(org.noear.snack4.ONode.ofJson(originalMetadata).get("createdAt").getLong(), info.createdAt());
        registry.renameProject(hash, "");
        var restored = registry.listProjects().stream().filter(item -> item.hash().equals(hash)).findFirst().orElseThrow();
        assertEquals("service", restored.name());
        assertNull(restored.displayName());
    }

    @Test
    void rejectsInvalidProjectNamesAndHashesBeforeWriting() throws Exception {
        ProjectRegistry registry = ProjectRegistry.getOrCreate(projects.toString());
        String hash = ProjectRegistry.computeProjectHash(projects.toString());
        String before = Files.readString(registry.getProjectConfigPath(projects.toString()));
        assertThrows(IllegalArgumentException.class, () -> registry.renameProject("../escape", "名称"));
        assertThrows(IllegalArgumentException.class, () -> registry.renameProject(hash, null));
        assertThrows(IllegalArgumentException.class, () -> registry.renameProject(hash, "x".repeat(81)));
        assertThrows(IllegalArgumentException.class, () -> registry.renameProject(hash, "第一行\n第二行"));
        assertThrows(IllegalArgumentException.class, () -> registry.renameProject("000000000000", "不存在"));
        assertEquals(before, Files.readString(registry.getProjectConfigPath(projects.toString())));
    }
}
