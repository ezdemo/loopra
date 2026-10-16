package site.sorghum.loopra.bin.goal;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.stream.IntStream;

import static org.junit.jupiter.api.Assertions.*;

class JsonlGoalStoreTest {

    @TempDir
    Path workspace;

    @Test
    void persistsEvidenceAndClosedStatus() throws Exception {
        GoalService service = new GoalService();
        Goal goal = service.create("session/a", "workspace", "验证持久化", List.of("写入", "读取"), null);
        service.updateStep(goal, 1, StepStatus.DONE, "写入成功");
        service.updateStep(goal, 2, StepStatus.SKIPPED, "已有覆盖");
        service.complete(goal, "快照往返成功");

        JsonlGoalStore store = new JsonlGoalStore(workspace);
        store.save(goal);
        Goal restored = store.findBySession("session/a");

        assertNotNull(restored);
        assertEquals(GoalStatus.COMPLETED, restored.getStatus());
        assertEquals("写入成功", restored.getSteps().get(0).getEvidence());
        assertEquals("快照往返成功", restored.getCompletionSummary());
    }

    @Test
    void atomicUpdatesDoNotLoseParallelStepProgress() throws Exception {
        GoalService service = new GoalService();
        List<String> steps = IntStream.rangeClosed(1, 12).mapToObj(i -> "步骤 " + i).toList();
        Goal goal = service.create("parallel", "workspace", "并行推进", steps, null);
        JsonlGoalStore store = new JsonlGoalStore(workspace);
        store.save(goal);

        ExecutorService executor = Executors.newFixedThreadPool(6);
        CountDownLatch start = new CountDownLatch(1);
        try {
            List<Future<Object>> updates = IntStream.rangeClosed(1, steps.size())
                    .mapToObj(index -> executor.submit(() -> {
                        start.await();
                        store.update("parallel", current ->
                                service.updateStep(current, index, StepStatus.DONE, "步骤 " + index + " 已验证"));
                        return null;
                    }))
                    .toList();
            start.countDown();
            for (Future<Object> update : updates) update.get();
        } finally {
            executor.shutdownNow();
        }

        Goal restored = store.findBySession("parallel");
        assertTrue(restored.isAllDone());
        assertEquals("12/12 (100%)", restored.progressText());
    }

    @Test
    void createIfNoOpenGoalIsAtomic() throws Exception {
        GoalService service = new GoalService();
        JsonlGoalStore store = new JsonlGoalStore(workspace);
        Goal first = service.create("same-session", "workspace", "目标一", List.of(), null);
        Goal second = service.create("same-session", "workspace", "目标二", List.of(), null);

        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            Future<Goal> firstResult = executor.submit(() -> store.createIfNoOpenGoal(first));
            Future<Goal> secondResult = executor.submit(() -> store.createIfNoOpenGoal(second));
            assertEquals(firstResult.get().getId(), secondResult.get().getId());
        } finally {
            executor.shutdownNow();
        }
        assertTrue(List.of(first.getId(), second.getId()).contains(
                store.findBySession("same-session").getId()));
    }

    @Test
    void distinctSessionIdsDoNotCollideAfterEncoding() throws Exception {
        GoalService service = new GoalService();
        JsonlGoalStore store = new JsonlGoalStore(workspace);
        store.save(service.create("a/b", "workspace", "目标一", List.of(), null));
        store.save(service.create("a?b", "workspace", "目标二", List.of(), null));

        assertEquals("目标一", store.findBySession("a/b").getTitle());
        assertEquals("目标二", store.findBySession("a?b").getTitle());
    }

    @Test
    void legacySnapshotIsReadAndMigratedOnUpdate() throws Exception {
        Path goalsDir = workspace.resolve("goals");
        Files.createDirectories(goalsDir);
        Path legacy = goalsDir.resolve("session_a.jsonl");
        Files.writeString(legacy, """
                {"id":"legacy","sessionId":"session/a","workspaceHash":"workspace",
                 "title":"旧目标","description":"旧目标","status":"ACTIVE",
                 "steps":[
                   {"index":0,"description":"旧步骤一","status":"DONE","lastError":"旧证据"},
                   {"index":1,"description":"旧步骤二","status":"PENDING"}
                 ]}
                """, StandardCharsets.UTF_8);
        GoalService service = new GoalService();
        JsonlGoalStore store = new JsonlGoalStore(workspace);

        Goal restored = store.findBySession("session/a");
        assertEquals(1, restored.getSteps().get(0).getIndex());
        assertEquals(2, restored.getSteps().get(1).getIndex());
        assertEquals("旧证据", restored.getSteps().get(0).getEvidence());
        store.update("session/a", current ->
                service.updateStep(current, 2, StepStatus.DONE, "迁移后可写"));

        assertFalse(Files.exists(legacy));
        assertTrue(store.findBySession("session/a").isAllDone());
    }

    @Test
    void collidingLegacySnapshotDoesNotBlockNewSession() throws Exception {
        GoalService service = new GoalService();
        Goal legacyGoal = service.create("a/b", "workspace", "旧目标", List.of(), null);
        Path goalsDir = workspace.resolve("goals");
        Files.createDirectories(goalsDir);
        Path legacy = goalsDir.resolve("a_b.jsonl");
        Files.writeString(legacy, JsonlGoalStore.serializeGoal(legacyGoal), StandardCharsets.UTF_8);
        JsonlGoalStore store = new JsonlGoalStore(workspace);

        Goal newGoal = service.create("a?b", "workspace", "新目标", List.of(), null);
        Goal stored = store.createIfNoOpenGoal(newGoal);

        assertEquals(newGoal.getId(), stored.getId());
        assertEquals(legacyGoal.getId(), store.findBySession("a/b").getId());
        assertEquals(newGoal.getId(), store.findBySession("a?b").getId());
        assertTrue(Files.exists(legacy));
    }

    @Test
    void unknownPersistedStatusFailsClosed() throws Exception {
        String sessionId = "broken";
        String encoded = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(sessionId.getBytes(StandardCharsets.UTF_8));
        Path goalsDir = workspace.resolve("goals");
        Files.createDirectories(goalsDir);
        Files.writeString(goalsDir.resolve("v2-" + encoded + ".jsonl"),
                "{\"sessionId\":\"broken\",\"status\":\"FUTURE_STATUS\",\"steps\":[]}",
                StandardCharsets.UTF_8);

        JsonlGoalStore store = new JsonlGoalStore(workspace);
        assertThrows(java.io.IOException.class, () -> store.findBySession(sessionId));
    }

    @Test
    void deleteRemovesBrokenSnapshotSoSessionCanRecover() throws Exception {
        String sessionId = "corrupt-session";
        String encoded = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(sessionId.getBytes(StandardCharsets.UTF_8));
        Path goalsDir = workspace.resolve("goals");
        Files.createDirectories(goalsDir);
        Path v2File = goalsDir.resolve("v2-" + encoded + ".jsonl");
        Path legacyFile = goalsDir.resolve("corrupt-session.jsonl");
        Files.writeString(v2File, "{corrupted json", StandardCharsets.UTF_8);
        Files.writeString(legacyFile, "not-json-at-all", StandardCharsets.UTF_8);

        JsonlGoalStore store = new JsonlGoalStore(workspace);
        assertThrows(java.io.IOException.class, () -> store.findBySession(sessionId));

        // 快照损坏时 delete 仍应成功，让用户可以用 /goal reset 恢复会话。
        assertTrue(store.delete(sessionId));
        assertFalse(Files.exists(v2File));
        assertFalse(Files.exists(legacyFile));
        assertNull(store.findBySession(sessionId));
    }
}
