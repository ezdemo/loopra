package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.loopra.bin.agent.environment.ChatMode;
import site.sorghum.loopra.bin.project.ProjectRegistry;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

class ProjectCatalogTest {
    @TempDir Path project;

    @Test void sessionLookupUsesRegisteredPathWithoutRewritingProjectOrSessionData() throws Exception {
        ProjectRegistry registry = ProjectRegistry.getOrCreate(project.toString());
        Path metadata = registry.getProjectConfigPath(project.toString());
        String before = Files.readString(metadata);
        ProjectCatalog catalog = new ProjectCatalog(Set::of);
        assertEquals(project.toString(), catalog.resolveProjectPath(ProjectRegistry.computeProjectHash(project.toString())));
        assertEquals(before, Files.readString(metadata));
        assertEquals(ChatMode.root().toString(), catalog.resolveProjectPath(ChatMode.WORKSPACE_HASH));
    }

    @Test void synchronizationChangesAreVisibleWithoutRestartOrCacheInvalidation() throws Exception {
        ProjectRegistry registry = ProjectRegistry.getOrCreate(project.toString());
        String hash = ProjectRegistry.computeProjectHash(project.toString());
        ProjectCatalog catalog = new ProjectCatalog(Set::of);
        assertEquals(project.toString(), catalog.resolveProjectPath(hash));
        Path moved = Files.createDirectories(project.resolve("synced-root"));
        org.noear.snack4.ONode metadata = org.noear.snack4.ONode.ofJson(Files.readString(registry.getProjectConfigPath(project.toString())));
        metadata.set("path", moved.toString());
        Files.writeString(registry.getProjectConfigPath(project.toString()), metadata.toJson());
        assertEquals(moved.toString(), catalog.resolveProjectPath(hash));
        assertTrue(catalog.listProjects().stream().anyMatch(item -> hash.equals(item.hash()) && moved.toString().equals(item.path())));
    }
}
