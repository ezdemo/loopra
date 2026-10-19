package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.loopra.tool.solon.common.LoopraSkillProvider;
import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.model.ProjectCapabilitiesDTO;

import java.nio.file.Path;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

class ProjectCapabilitiesServiceTest {

    @TempDir
    Path project;

    private final SessionAgentRegistry sessions = new SessionAgentRegistry(10, (key, agent) -> { });
    private final List<String> events = new ArrayList<>();

    @Test
    void projectSkillMetadataKeepsItsScopeAliasAndLocalDirectoryAfterRefresh() throws Exception {
        ProjectCapabilitiesService service = new ProjectCapabilitiesService(new Object(), sessions, root -> Set.of());
        try {
            assertTrue(service.get(project.toString()).skills().isEmpty());
            Path skill = project.resolve(".loopra/skills/example/SKILL.md");
            Files.createDirectories(skill.getParent());
            Files.writeString(skill, "---\ndescription: Example project skill\n---\nRead project files.");

            var skills = service.get(project.toString()).skills();
            assertEquals(1, skills.size());
            assertEquals("example", skills.get(0).name());
            assertEquals("Example project skill", skills.get(0).description());
            assertEquals("project", skills.get(0).scope());
            assertEquals("@project-skills", skills.get(0).mountAlias());
            assertEquals(skill.getParent().toString(), skills.get(0).path());
        } finally {
            LoopraSkillProvider.removeFor(project.toString());
        }
    }

    private ProjectCapabilitiesService service() {
        return new ProjectCapabilitiesService(new Object(), sessions,
                root -> {
                    events.add("invalidate:" + root);
                    return Set.of();
                }, root -> {
                    events.add("read:" + root);
                    return capabilities(root);
                }, root -> events.add("close:" + root));
    }

    @Test
    void normalizedRequestsCoalesceAndWaitForTheLastTaskInTheProject() {
        ProjectCapabilitiesService service = service();
        String key = project + "::session";
        sessions.registerTask(key, "first");
        sessions.registerTask(key, "second");
        service.requestRefresh(project.toString());
        service.requestRefresh(project.resolve("child/..").toString());
        service.applyPending(project.toString());
        assertTrue(events.isEmpty());

        sessions.unregisterTask(key, "first");
        service.applyPending(project.toString());
        assertTrue(events.isEmpty());
        sessions.unregisterTask(key, "second");
        service.applyPending(project.toString());
        service.applyPending(project.toString());
        assertEquals(List.of("invalidate:" + project, "close:" + project, "read:" + project), events);
    }

    @Test
    void manualRefreshRejectsBusyProjectsBeforeInvalidatingAnyResource() {
        ProjectCapabilitiesService service = service();
        sessions.registerTask(project + "::session", "queued");

        ServiceException error = assertThrows(ServiceException.class, () -> service.refresh(project.toString()));
        assertEquals(400, error.getCode());
        assertTrue(events.isEmpty());
        assertTrue(sessions.status(project + "::session").running());
    }

    @Test
    void anotherProjectsTaskDoesNotBlockOrConsumeThisProjectsRefresh() {
        ProjectCapabilitiesService service = service();
        Path other = project.resolve("other");
        sessions.registerTask(other + "::session", "other-request");
        service.requestRefresh(project.toString());
        service.requestRefresh(other.toString());

        service.applyPending(project.toString());
        service.applyPending(other.toString());
        assertEquals(3, events.size());
        assertTrue(events.contains("close:" + project));
        assertFalse(events.contains("close:" + other));

        sessions.unregisterTask(other + "::session", "other-request");
        service.applyPending(other.toString());
        assertEquals(6, events.size());
        assertTrue(events.contains("close:" + other));
    }

    @Test
    void aHeldSessionLockKeepsRefreshPendingEvenBeforeTheAgentLoopStarts() {
        ProjectCapabilitiesService service = service();
        var lock = sessions.getLock(project + "::session");
        lock.lock();
        try {
            service.requestRefresh(project.toString());
            assertThrows(ServiceException.class, () -> service.refresh(project.toString()));
            service.applyPending(project.toString());
            assertTrue(events.isEmpty());
        } finally {
            lock.unlock();
        }
        service.applyPending(project.toString());
        assertEquals(3, events.size());
    }

    @Test
    void aRefreshRegisteredDuringReloadIsNotRemovedByTheOlderSuccess() {
        AtomicReference<ProjectCapabilitiesService> reference = new AtomicReference<>();
        AtomicInteger reads = new AtomicInteger();
        ProjectCapabilitiesService service = new ProjectCapabilitiesService(new Object(), sessions, root -> Set.of(),
                root -> {
                    if (reads.incrementAndGet() == 1) reference.get().requestRefresh(root.toString());
                    return capabilities(root);
                }, root -> { });
        reference.set(service);

        service.requestRefresh(project.toString());
        service.applyPending(project.toString());
        service.applyPending(project.toString());
        service.applyPending(project.toString());
        assertEquals(2, reads.get());
    }

    @Test
    void aNewRefreshAlsoSurvivesFailureOfTheOlderReload() {
        AtomicReference<ProjectCapabilitiesService> reference = new AtomicReference<>();
        AtomicInteger reads = new AtomicInteger();
        ProjectCapabilitiesService service = new ProjectCapabilitiesService(new Object(), sessions, root -> Set.of(),
                root -> {
                    if (reads.incrementAndGet() == 1) {
                        reference.get().requestRefresh(root.toString());
                        throw new IllegalStateException("failed reload");
                    }
                    return capabilities(root);
                }, root -> { });
        reference.set(service);
        service.requestRefresh(project.toString());

        service.applyPending(project.toString());
        service.applyPending(project.toString());
        assertEquals(2, reads.get());
    }

    @Test
    void invalidPathsAreRejectedBeforeInvokingRuntimeDependencies() {
        ProjectCapabilitiesService service = service();
        assertTrue(service.requestRefresh(null).startsWith("WORKSPACE_MISSING:"));
        assertTrue(service.requestRefresh(String.valueOf((char) 0)).startsWith("WORKSPACE_MISSING:"));
        assertThrows(ServiceException.class, () -> service.refresh(" "));
        assertThrows(ServiceException.class, () -> service.get(String.valueOf((char) 0)));
        assertTrue(service.get(null).mcpServers().isEmpty());
        service.applyPending(project.toString());
        assertTrue(events.isEmpty());
    }

    @Test
    void aFailedIdleRefreshCanBeRequestedAgainAndReleasesSessionLocks() {
        AtomicBoolean fail = new AtomicBoolean(true);
        AtomicInteger reads = new AtomicInteger();
        var sessionLock = sessions.getLock(project + "::session");
        ProjectCapabilitiesService service = new ProjectCapabilitiesService(new Object(), sessions, root -> Set.of(),
                root -> {
                    reads.incrementAndGet();
                    if (fail.get()) throw new IllegalStateException("failed reload");
                    return capabilities(root);
                }, root -> { });
        service.requestRefresh(project.toString());
        service.applyPending(project.toString());
        assertFalse(sessionLock.isLocked());
        service.applyPending(project.toString());
        assertEquals(1, reads.get());

        fail.set(false);
        service.requestRefresh(project.toString());
        service.applyPending(project.toString());
        assertEquals(2, reads.get());
        assertFalse(sessionLock.isLocked());
    }

    private static ProjectCapabilitiesDTO capabilities(Path root) {
        return new ProjectCapabilitiesDTO(root.toString(), null, false, null, false, List.of(), List.of());
    }
}
