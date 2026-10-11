package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.requirement.Requirement;
import site.sorghum.loopra.bin.requirement.RequirementStore;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 需求池管理器单元测试：增删改查 / 评论注入 / 执行器（run/finish/abort/ticker/兜底）。
 *
 * @author Sorghum
 */
class RequirementManagerTest {

    @TempDir
    Path tempDir;

    /** AgentService 探针：记录调用并模拟执行结果。 */
    private static class StubAgentService extends AgentService {
        final List<String> injectedComments = new ArrayList<>();
        final List<String> executedSessions = new ArrayList<>();
        final List<Boolean> executedWebHidden = new ArrayList<>();
        final List<String> executedConfigs = new ArrayList<>();
        final List<String> abortedSessions = new ArrayList<>();
        final CountDownLatch executedLatch = new CountDownLatch(1);
        final CountDownLatch blockExecute = new CountDownLatch(1);
        boolean workspaceExists = true;
        boolean throwOnExecute = false;
        boolean blockExecution = false;
        boolean pendingApproval = false;
        boolean approvalResolved = false;
        /** 模拟 AI 在 chat 内调用 finish_requirement（由测试注入） */
        Runnable onExecute = null;

        @Override
        public String resolveProjectPath(String hash) {
            return workspaceExists ? "/tmp/" + hash : null;
        }

        @Override
        public void appendUserMessage(String workspacePath, String sessionName, String text) {
            injectedComments.add(text);
        }

        @Override
        public void appendAssistantMessage(String workspacePath, String sessionName, String content) {
            injectedComments.add("[AI] " + content);
        }

        @Override
        public void abortChat(String workspacePath, String sessionName) {
            abortedSessions.add(sessionName);
        }

        @Override
        public List<ChatMessage> getHistory(String workspacePath, String sessionName) {
            ChatMessage message = ChatMessage.ofUser("历史消息");
            return List.of(message);
        }

        @Override
        public boolean hasPendingRequirementApproval(String workspacePath, String sessionName) {
            return pendingApproval;
        }

        @Override
        public String resolveRequirementApproval(String workspacePath, String sessionName, boolean approved) {
            approvalResolved = approved;
            pendingApproval = false;
            return "ok";
        }

        @Override
        public String executeRequirement(String workspacePath, String sessionName, String systemPrompt, String message,
                                         boolean webHidden, String model, String modelChannelId,
                                         String reasoningEffort, String hitl) {
            executedSessions.add(sessionName);
            executedWebHidden.add(webHidden);
            executedConfigs.add(String.join("|", String.valueOf(model), String.valueOf(modelChannelId),
                    String.valueOf(reasoningEffort), String.valueOf(hitl)));
            executedLatch.countDown();
            if (blockExecution) {
                try {
                    blockExecute.await();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
            if (onExecute != null) onExecute.run(); // 模拟 AI 调用 finish_requirement
            if (throwOnExecute) {
                throw new RuntimeException("模拟执行异常");
            }
            return "ok";
        }
    }

    private StubAgentService agentService;
    private RequirementManager manager;

    @BeforeEach
    void setUp() {
        agentService = new StubAgentService();
        manager = new RequirementManager(new RequirementStore(tempDir), agentService);
    }

    @AfterEach
    void tearDown() {
        manager.destroy();
        awaitExecutorTermination();
    }

    // ==================== 增删改查 / 评论 ====================

    @Test
    void createGeneratesIdSessionAndTodoStatus() {
        Requirement created = manager.create(draft("优化性能", "p1", "agent4j", "high"));

        assertNotNull(created.getId());
        assertEquals("req_" + created.getId(), created.getSessionName());
        assertEquals("todo", created.getStatus());
        assertEquals("", created.getSummary());
        assertNull(created.getModel());
        assertNull(created.getModelChannelId());
        assertNull(created.getReasoningEffort());
        assertNull(created.getHitl());
        assertEquals(1, manager.list().size());
    }

    @Test
    void createPreservesExecutionConfiguration() {
        Requirement draft = draft("优化性能", "p1", "agent4j", "high");
        draft.setModel("gpt-5");
        draft.setModelChannelId("openai");
        draft.setReasoningEffort("max");
        draft.setHitl("approval");

        Requirement created = manager.create(draft);

        assertEquals("gpt-5", created.getModel());
        assertEquals("openai", created.getModelChannelId());
        assertEquals("max", created.getReasoningEffort());
        assertEquals("approval", created.getHitl());
    }

    @Test
    void updateOnlyChangesDescriptionAndPriority() {
        Requirement created = manager.create(draft("优化性能", "p1", "agent4j", "high"));
        created.setStatus("doing");

        Requirement updated = manager.update(created.getId(),
                Requirement.builder().description("新描述").priority("low").build());

        assertEquals("新描述", updated.getDescription());
        assertEquals("low", updated.getPriority());
        assertEquals("doing", updated.getStatus());
        assertEquals("优化性能", updated.getTitle());
    }

    @Test
    void addCommentInjectsWebHiddenUserMessage() {
        Requirement created = manager.create(draft("优化性能", "p1", "agent4j", "high"));

        assertTrue(manager.addComment(created.getId(), "请优先处理"));
        assertEquals(List.of("请优先处理"), agentService.injectedComments);
    }

    @Test
    void addCommentFailsWhenProjectMissing() {
        Requirement created = manager.create(draft("优化性能", "p1", "agent4j", "high"));
        agentService.workspaceExists = false;

        assertFalse(manager.addComment(created.getId(), "评论"));
        assertTrue(agentService.injectedComments.isEmpty());
    }

    @Test
    void commentOnFinishedRequirementTriggersReplyRound() throws Exception {
        Requirement draft = draft("优化性能", "p1", "agent4j", "high");
        draft.setModel("gpt-5");
        draft.setModelChannelId("openai");
        draft.setReasoningEffort("max");
        draft.setHitl("approval");
        Requirement created = manager.create(draft);
        // 先执行完成（兜底 done）
        assertEquals("started", manager.run(created.getId()));
        awaitStatus(created.getId(), "done");
        int executedCount = agentService.executedSessions.size();

        // 执行完成后评论 → 异步触发回复回合（再次驱动 Agent，状态不变）
        assertTrue(manager.addComment(created.getId(), "执行得不错"));
        awaitCount(() -> agentService.executedSessions.size() >= executedCount + 1, "回复回合未触发");

        assertEquals("done", find(created.getId()).getStatus());
        assertTrue(agentService.injectedComments.contains("执行得不错"));
        assertEquals("gpt-5|openai|max|approval",
                agentService.executedConfigs.get(agentService.executedConfigs.size() - 1));
    }

    @Test
    void commentOnTodoRequirementDoesNotTriggerReplyRound() throws Exception {
        Requirement created = manager.create(draft("优化性能", "p1", "agent4j", "high"));

        assertTrue(manager.addComment(created.getId(), "待执行评论"));
        // todo 状态不触发回复回合（评论将在执行时被 Agent 看到）
        Thread.sleep(100);
        assertTrue(agentService.executedSessions.isEmpty());
    }

    // ==================== 执行器 ====================

    @Test
    void runStartsExecutionAndFlipsStatusToDoingThenDone() throws Exception {
        Requirement created = manager.create(draft("优化性能", "p1", "agent4j", "high"));
        // 保持执行中，确保断言时任务不会抢先异步完成
        agentService.blockExecution = true;

        assertEquals("started", manager.run(created.getId()));

        Requirement running = find(created.getId());
        assertEquals("doing", running.getStatus());
        assertTrue(agentService.executedLatch.await(3, TimeUnit.SECONDS));
        assertEquals(List.of(running.getSessionName()), agentService.executedSessions);
        assertEquals(List.of(true), agentService.executedWebHidden);
        assertEquals(List.of("null|null|null|null"), agentService.executedConfigs);

        // 放行执行 → AI 未显式调用 finish_requirement → 兜底完成 + 写 AI 结束评论
        agentService.blockExecute.countDown();
        awaitStatus(created.getId(), "done");
        assertTrue(find(created.getId()).getSummary().contains("未显式调用 finish_requirement"));
        // 状态翻转早于结束评论落盘，需等待评论而非直接断言
        awaitCount(() -> agentService.injectedComments.stream().anyMatch(c -> c.contains("✅ 已完成")),
                "AI 完成评论未写入");
    }

    @Test
    void approvalModePausesAndResumesTheRequirement() throws Exception {
        Requirement draft = draft("优化性能", "p1", "agent4j", "high");
        draft.setHitl("approval");
        Requirement created = manager.create(draft);
        agentService.pendingApproval = true;

        assertEquals("started", manager.run(created.getId()));
        awaitApprovalPending(created.getId());
        assertEquals("doing", find(created.getId()).getStatus());
        assertTrue(manager.resolveApproval(created.getId(), true));
        awaitStatus(created.getId(), "done");
        assertTrue(agentService.approvalResolved);
    }

    @Test
    void runUsesRequirementExecutionConfiguration() throws Exception {
        Requirement draft = draft("优化性能", "p1", "agent4j", "high");
        draft.setModel("gpt-5");
        draft.setModelChannelId("openai");
        draft.setReasoningEffort("high");
        draft.setHitl("approval");
        Requirement created = manager.create(draft);

        assertEquals("started", manager.run(created.getId()));
        assertTrue(agentService.executedLatch.await(3, TimeUnit.SECONDS));

        assertEquals(List.of("gpt-5|openai|high|approval"), agentService.executedConfigs);
    }

    @Test
    void finishDeclarationWritesAIFinishComment() throws Exception {
        Requirement created = manager.create(draft("优化性能", "p1", "agent4j", "high"));
        // 模拟 AI 在 chat 内调用 finish_requirement(done, 总结)
        agentService.onExecute = () -> manager.finish(created.getId(), "done", "完成重构，测试全过");

        assertEquals("started", manager.run(created.getId()));
        awaitStatus(created.getId(), "done");

        assertEquals("完成重构，测试全过", find(created.getId()).getSummary());
        // 结束评论：✅ 前缀 + 总结；finish() 先翻转状态再写评论，需等待评论落盘而非直接断言
        awaitCount(() -> agentService.injectedComments.stream()
                        .anyMatch(c -> c.equals("[AI] ✅ 已完成：完成重构，测试全过")),
                "AI 结束评论未写入");
    }

    @Test
    void runRejectsWhenAlreadyDoingOrRunning() throws Exception {
        Requirement created = manager.create(draft("优化性能", "p1", "agent4j", "high"));

        assertEquals("started", manager.run(created.getId()));
        // doing 中重复触发
        assertEquals("busy", manager.run(created.getId()));
        agentService.executedLatch.await(3, TimeUnit.SECONDS);
        awaitStatus(created.getId(), "done");
        // 已完成不可触发
        assertEquals("busy", manager.run(created.getId()));
    }

    @Test
    void runAllowsRetryFromFailed() throws Exception {
        Requirement created = manager.create(draft("优化性能", "p1", "agent4j", "high"));
        agentService.throwOnExecute = true;

        assertEquals("started", manager.run(created.getId()));
        awaitStatus(created.getId(), "failed");
        assertTrue(find(created.getId()).getSummary().contains("模拟执行异常"));
        // 异常兜底同样写 AI 结束评论（❌）；状态翻转早于评论落盘，需等待评论而非直接断言
        awaitCount(() -> agentService.injectedComments.stream().anyMatch(c -> c.contains("❌ 已失败")),
                "AI 失败评论未写入");

        // 手动重试：failed → doing → 成功（本次不抛异常）
        agentService.throwOnExecute = false;
        assertEquals("started", manager.run(created.getId()));
        awaitStatus(created.getId(), "done");
    }

    @Test
    void finishFlipsStatusAndSummary() {
        Requirement created = manager.create(draft("优化性能", "p1", "agent4j", "high"));

        manager.finish(created.getId(), "done", "完成重构，测试全过");
        Requirement done = find(created.getId());
        assertEquals("done", done.getStatus());
        assertEquals("完成重构，测试全过", done.getSummary());

        manager.finish(created.getId(), "failed", "接口限流");
        Requirement failed = find(created.getId());
        assertEquals("failed", failed.getStatus());
        assertEquals("接口限流", failed.getSummary());
    }

    @Test
    void abortReturnsToTodoAndInterruptsSession() throws Exception {
        Requirement created = manager.create(draft("优化性能", "p1", "agent4j", "high"));
        agentService.blockExecution = true; // 保持执行中，模拟真实 chat 阻塞
        manager.run(created.getId());
        // 等待执行启动（latch 在 executeRequirement 入口计数）
        assertTrue(agentService.executedLatch.await(3, TimeUnit.SECONDS));
        assertEquals("doing", find(created.getId()).getStatus());

        assertTrue(manager.abort(created.getId()));
        assertEquals("todo", find(created.getId()).getStatus());
        assertEquals(1, agentService.abortedSessions.size());

        // 放行阻塞的执行，验证兜底不覆盖已取消状态，且不写结束评论
        agentService.blockExecute.countDown();
        Thread.sleep(100);
        assertEquals("todo", find(created.getId()).getStatus());
        assertTrue(agentService.injectedComments.stream().noneMatch(c -> c.contains("✅") || c.contains("❌")));
    }

    @Test
    void scanAndRunOnlyPicksTodoRequirements() throws Exception {
        Requirement todoA = manager.create(draft("待执行A", "p1", "agent4j", "high"));
        Requirement todoB = manager.create(draft("待执行B", "p1", "agent4j", "medium"));
        Requirement doing = manager.create(draft("执行中", "p1", "agent4j", "high"));
        doing.setStatus("doing");
        manager.update(doing.getId(), Requirement.builder().build());
        Requirement done = manager.create(draft("已完成", "p1", "agent4j", "high"));
        done.setStatus("done");
        manager.update(done.getId(), Requirement.builder().build());

        agentService.blockExecution = true; // 保持执行中，避免异步任务立刻兜底完成
        manager.scanAndRun();
        assertTrue(agentService.executedLatch.await(3, TimeUnit.SECONDS));

        // 两个 todo 被拉起（并发上限 2 内）
        assertEquals("doing", find(todoA.getId()).getStatus());
        assertEquals("doing", find(todoB.getId()).getStatus());
        // doing/done 不被触碰
        assertEquals("doing", find(doing.getId()).getStatus());
        assertEquals("done", find(done.getId()).getStatus());

        agentService.blockExecute.countDown();
        Thread.sleep(200);
    }

    @Test
    void scanAndRunDefersFutureScheduledRequirementUntilDue() throws Exception {
        Requirement draft = draft("定时执行", "p1", "agent4j", "medium");
        draft.setScheduleMode("scheduled");
        draft.setScheduledAt(System.currentTimeMillis() + TimeUnit.MINUTES.toMillis(1));
        Requirement scheduled = manager.create(draft);
        agentService.blockExecution = true;

        manager.scanAndRun();
        assertEquals("scheduled", scheduled.getScheduleMode());
        assertEquals("todo", find(scheduled.getId()).getStatus());
        assertTrue(agentService.executedSessions.isEmpty());

        scheduled.setScheduledAt(System.currentTimeMillis() - 1);
        manager.update(scheduled.getId(), Requirement.builder().build());
        manager.scanAndRun();
        assertTrue(agentService.executedLatch.await(3, TimeUnit.SECONDS));
        assertEquals("doing", find(scheduled.getId()).getStatus());

        agentService.blockExecute.countDown();
    }

    @Test
    void getMessagesReadsSessionHistory() {
        Requirement created = manager.create(draft("优化性能", "p1", "agent4j", "high"));

        List<ChatMessage> messages = manager.getMessages(created.getId());
        assertEquals(1, messages.size());
        assertEquals("历史消息", messages.get(0).getContent());
    }

    @Test
    void replyCommentInjectsAssistantMessage() {
        Requirement created = manager.create(draft("优化性能", "p1", "agent4j", "high"));

        assertTrue(manager.replyComment(created.getId(), "收到，正在处理"));
        assertEquals(List.of("[AI] 收到，正在处理"), agentService.injectedComments);
    }

    // ==================== 工具上下文 ====================

    private Requirement find(String id) {
        return manager.list().stream().filter(r -> r.getId().equals(id)).findFirst().orElse(null);
    }

    private void awaitStatus(String id, String status) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 5000;
        while (System.currentTimeMillis() < deadline) {
            Requirement requirement = find(id);
            if (requirement != null && status.equals(requirement.getStatus())) {
                return;
            }
            Thread.sleep(20);
        }
        fail("等待状态超时: " + status);
    }

    private void awaitApprovalPending(String id) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 5000;
        while (System.currentTimeMillis() < deadline) {
            Requirement requirement = find(id);
            if (requirement != null && requirement.isApprovalPending()) {
                return;
            }
            Thread.sleep(20);
        }
        fail("等待审批状态超时");
    }

    private void awaitCount(java.util.function.BooleanSupplier condition, String message) throws InterruptedException {
        long deadline = System.currentTimeMillis() + 5000;
        while (System.currentTimeMillis() < deadline) {
            if (condition.getAsBoolean()) {
                return;
            }
            Thread.sleep(20);
        }
        fail(message);
    }

    private void awaitExecutorTermination() {
        try {
            java.lang.reflect.Field field = RequirementManager.class.getDeclaredField("executor");
            field.setAccessible(true);
            ExecutorService executor = (ExecutorService) field.get(manager);
            if (!executor.awaitTermination(5, TimeUnit.SECONDS)) {
                fail("执行线程在 5s 内未退出");
            }
        } catch (Exception e) {
            throw new IllegalStateException("等待执行线程退出失败", e);
        }
    }

    private static Requirement draft(String title, String projectHash, String projectName, String priority) {
        return Requirement.builder()
                .title(title)
                .description("描述")
                .priority(priority)
                .projectHash(projectHash)
                .projectName(projectName)
                .build();
    }
}
