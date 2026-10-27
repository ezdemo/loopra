package site.sorghum.loopra.bin.schedule;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class ScheduleHistoryTest {
    @TempDir Path workspaceDirectory;

    @Test
    void recordsSuccessfulAndFailedExecutionsAcrossReloads() throws Exception {
        Path project = workspaceDirectory.resolve("project");
        Files.createDirectories(project);
        Files.writeString(project.resolve("workspace.json"), "{\"path\":\"project-path\"}");
        AtomicInteger calls = new AtomicInteger();
        ScheduleService service = new ScheduleService(new ScheduleStore(workspaceDirectory), (path, session, message) -> {
            if (calls.incrementAndGet() == 2) throw new IllegalStateException("execution failed");
            return "full result";
        }, workspaceDirectory);
        service.start();
        try {
            ScheduledTask task = new ScheduledTask();
            task.setName("check");
            task.setSessionName("session");
            task.setMessage("inspect");
            task.setIntervalSec(3600L);
            task = service.create("project", task);
            assertEquals("full result", service.runNow("project", task.getId()));
            String taskId = task.getId();
            assertThrows(IllegalStateException.class, () -> service.runNow("project", taskId));

            ScheduledTask restored = new ScheduleStore(workspaceDirectory).load("project").get(taskId);
            assertEquals(2, restored.getRunCount());
            assertEquals(2, restored.getRuns().size());
            assertEquals("error", restored.getRuns().get(0).getStatus());
            assertEquals("execution failed", restored.getRuns().get(0).getError());
            assertEquals("success", restored.getRuns().get(1).getStatus());
            assertEquals("full result", restored.getRuns().get(1).getResult());
            assertEquals("inspect", restored.getRuns().get(1).getMessage());
        } finally {
            service.stop();
        }
    }

    @Test
    void loadsOlderTasksWithoutExecutionHistory() throws Exception {
        Path file = workspaceDirectory.resolve("project/schedules/schedules.json");
        Files.createDirectories(file.getParent());
        Files.writeString(file, "[{\"id\":\"old\",\"runCount\":3}]");
        ScheduledTask task = new ScheduleStore(workspaceDirectory).load("project").get("old");
        assertNotNull(task);
        assertTrue(task.getRuns().isEmpty());
        assertEquals(3, task.getRunCount());
    }

    @Test
    void independentRunsUseDifferentSessionsAndPersistTheirNames() throws Exception {
        Path project = workspaceDirectory.resolve("project");
        Files.createDirectories(project);
        Files.writeString(project.resolve("workspace.json"), "{\"path\":\"project-path\"}");
        List<String> sessions = new ArrayList<>();
        ScheduleService service = new ScheduleService(new ScheduleStore(workspaceDirectory), (path, session, message) -> {
            sessions.add(session);
            return "ok";
        }, workspaceDirectory);
        service.start();
        try {
            ScheduledTask task = new ScheduledTask();
            task.setName("independent");
            task.setSessionMode("independent");
            task.setMessage("inspect");
            task.setIntervalSec(3600L);
            task = service.create("project", task);
            service.runNow("project", task.getId());
            service.runNow("project", task.getId());
            assertEquals(2, sessions.size());
            assertNotEquals(sessions.get(0), sessions.get(1));
            assertTrue(sessions.get(0).startsWith("automation-"));
            ScheduledTask restored = new ScheduleStore(workspaceDirectory).load("project").get(task.getId());
            assertEquals("independent", restored.getSessionMode());
            assertEquals(sessions.get(1), restored.getRuns().get(0).getSessionName());
            assertEquals(sessions.get(0), restored.getRuns().get(1).getSessionName());
        } finally {
            service.stop();
        }
    }
}
