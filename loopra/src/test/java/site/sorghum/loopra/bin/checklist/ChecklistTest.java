package site.sorghum.loopra.bin.checklist;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Checklist 与 ChecklistEngine 单元测试。
 *
 * @author Sorghum
 */
class ChecklistTest {

    @TempDir
    Path tempDir;

    private ChecklistEngine createEngine() {
        return new ChecklistEngine();
    }

    private List<ChecklistEngine.StepDef> stepDefs(String... descriptions) {
        List<ChecklistEngine.StepDef> list = new ArrayList<>();
        for (String desc : descriptions) {
            list.add(new ChecklistEngine.StepDef(desc, StepKind.STEP));
        }
        return list;
    }

    @Test
    void testCreateChecklist() {
        ChecklistEngine engine = createEngine();
        Checklist cl = engine.createChecklist(
                "session-1", "hash-1", "测试清单", "描述",
                stepDefs("第一步", "第二步", "第三步"));

        // 验证基本字段
        assertNotNull(cl);
        assertNotNull(cl.getId());
        assertEquals("测试清单", cl.getTitle());
        assertEquals("描述", cl.getDescription());
        assertEquals("session-1", cl.getSessionId());
        assertEquals("hash-1", cl.getWorkspaceHash());

        // 验证初始状态
        assertEquals("ACTIVE", cl.getStatus());
        assertEquals(1, cl.getCurrentStepIndex());

        // 验证第一步为 RUNNING
        ChecklistStep first = cl.currentStep();
        assertNotNull(first);
        assertEquals("step-1", first.getId());
        assertEquals(StepStatus.RUNNING, first.getStatus());

        // 验证其他步骤为 PENDING
        assertEquals(3, cl.getSteps().size());
        assertEquals("step-2", cl.getSteps().get(1).getId());
        assertEquals(StepStatus.PENDING, cl.getSteps().get(1).getStatus());
        assertEquals("step-3", cl.getSteps().get(2).getId());
        assertEquals(StepStatus.PENDING, cl.getSteps().get(2).getStatus());

        // 验证时间戳
        assertNotNull(cl.getCreatedAt());
        assertNotNull(cl.getUpdatedAt());
    }

    @Test
    void testMarkCurrentDone() {
        ChecklistEngine engine = createEngine();
        Checklist cl = engine.createChecklist(
                "session-2", "hash-2", "标记完成", "",
                stepDefs("第一步", "第二步"));

        // 标记第一步完成
        ChecklistEngine.MarkResult result = engine.markCurrentDone(cl, "结果A");

        // 验证返回结果类型
        assertEquals("progress", result.getType());

        // 验证第一步状态
        ChecklistStep step1 = cl.getSteps().get(0);
        assertEquals(StepStatus.DONE, step1.getStatus());
        assertEquals("结果A", step1.getResult());
        assertNotNull(step1.getCompletedAt());

        // 验证自动推进到第二步（index 从 1 变为 2）
        assertEquals(2, cl.getCurrentStepIndex());

        // 验证第二步变为 RUNNING
        ChecklistStep step2 = cl.currentStep();
        assertNotNull(step2);
        assertEquals("step-2", step2.getId());
        assertEquals(StepStatus.RUNNING, step2.getStatus());

        // 验证 updatedAt 已刷新
        assertNotNull(cl.getUpdatedAt());
    }

    @Test
    void testMarkAllDone() {
        ChecklistEngine engine = createEngine();
        Checklist cl = engine.createChecklist(
                "session-3", "hash-3", "全部完成", "",
                stepDefs("A", "B", "C"));

        // 逐一标记所有步骤完成
        for (int i = 1; i <= 3; i++) {
            engine.markCurrentDone(cl, "第" + i + "步结果");
        }

        // 验证最终状态
        assertEquals("COMPLETED", cl.getStatus());
        assertTrue(cl.isAllDone());
        assertFalse(cl.hasFailed());
        assertNotNull(cl.getCompletedAt());

        // 验证所有步骤为 DONE
        for (ChecklistStep step : cl.getSteps()) {
            assertEquals(StepStatus.DONE, step.getStatus());
        }

        // 验证最后一步仍可通过 currentStep 访问（advance 返回 -1 但未修改 index）
        ChecklistStep lastStep = cl.currentStep();
        assertNotNull(lastStep);
        assertEquals("step-3", lastStep.getId());
        assertEquals(StepStatus.DONE, lastStep.getStatus());
    }

    @Test
    void testMarkCurrentFailed() {
        ChecklistEngine engine = createEngine();
        Checklist cl = engine.createChecklist(
                "session-4", "hash-4", "标记失败", "",
                stepDefs("第一步", "第二步"));

        // 标记当前步骤失败
        ChecklistEngine.MarkResult result = engine.markCurrentFailed(cl, "发生错误");

        // 验证返回结果
        assertEquals("failed", result.getType());

        // 验证清单状态
        assertEquals("FAILED", cl.getStatus());
        assertTrue(cl.hasFailed());

        // 验证当前步骤为 FAILED
        ChecklistStep step = cl.currentStep();
        assertNotNull(step);
        assertEquals(StepStatus.FAILED, step.getStatus());
        assertEquals("发生错误", step.getResult());
        assertNotNull(step.getCompletedAt());

        // 验证后续步骤未受影响（仍为 PENDING）
        assertEquals(StepStatus.PENDING, cl.getSteps().get(1).getStatus());

        // 不是全部完成
        assertFalse(cl.isAllDone());
    }

    @Test
    void testSkipCurrent() {
        ChecklistEngine engine = createEngine();
        Checklist cl = engine.createChecklist(
                "session-5", "hash-5", "跳过步骤", "",
                stepDefs("第一步", "第二步", "第三步"));

        // 跳过第一步
        ChecklistEngine.MarkResult result = engine.skipCurrent(cl, "不需要");

        // 验证返回结果
        assertEquals("progress", result.getType());

        // 验证第一步被跳过
        ChecklistStep step1 = cl.getSteps().get(0);
        assertEquals(StepStatus.SKIPPED, step1.getStatus());
        assertEquals("不需要", step1.getResult());
        assertNotNull(step1.getCompletedAt());

        // 验证自动推进到第二步
        assertEquals(2, cl.getCurrentStepIndex());

        // 验证第二步变为 RUNNING
        ChecklistStep step2 = cl.currentStep();
        assertNotNull(step2);
        assertEquals("step-2", step2.getId());
        assertEquals(StepStatus.RUNNING, step2.getStatus());

        // 跳过所有步骤直到完成
        engine.skipCurrent(cl, "跳过");
        engine.skipCurrent(cl, "跳过");

        // 最终状态应为 COMPLETED（引擎将跳过最后一步后的清单标记为完成）
        assertEquals("COMPLETED", cl.getStatus());
        // 注意：isAllDone() 只检查 DONE 状态的步骤，跳过(SKIPPED)的步骤不计入
        assertFalse(cl.isAllDone());
    }

    @Test
    void testIsAllDone() {
        // 空清单：所有步骤（零个）都是 DONE → true
        Checklist emptyCl = Checklist.builder()
                .id("empty")
                .title("空清单")
                .steps(new ArrayList<>())
                .currentStepIndex(0)
                .status("ACTIVE")
                .build();
        assertTrue(emptyCl.isAllDone());

        // 有步骤但未完成 → false
        ChecklistEngine engine = createEngine();
        Checklist cl = engine.createChecklist(
                "session-6", "hash-6", "部分完成", "",
                stepDefs("A", "B"));
        assertFalse(cl.isAllDone());

        // 完成一步，仍不是全部完成
        engine.markCurrentDone(cl, "A完成");
        assertFalse(cl.isAllDone());

        // 全部完成 → true
        engine.markCurrentDone(cl, "B完成");
        assertTrue(cl.isAllDone());
    }

    @Test
    void testProgressText() {
        ChecklistEngine engine = createEngine();
        Checklist cl = engine.createChecklist(
                "session-7", "hash-7", "进度测试", "",
                stepDefs("A", "B", "C", "D", "E"));

        // 初始：还没有 DONE 的步骤（第一步是 RUNNING，不是 DONE）
        assertEquals("0/5 (0%)", cl.progressText());

        // 完成第一步
        engine.markCurrentDone(cl, "A");
        assertEquals("1/5 (20%)", cl.progressText());

        // 完成第二步
        engine.markCurrentDone(cl, "B");
        assertEquals("2/5 (40%)", cl.progressText());

        // 完成第三、第四步
        engine.markCurrentDone(cl, "C");
        engine.markCurrentDone(cl, "D");
        assertEquals("4/5 (80%)", cl.progressText());

        // 全部完成
        engine.markCurrentDone(cl, "E");
        assertEquals("5/5 (100%)", cl.progressText());
    }

    @Test
    void testSaveAndLoad() {
        ChecklistEngine engine = createEngine();
        Checklist cl = engine.createChecklist(
                "session-save", "hash-save", "持久化测试",
                "测试描述",
                stepDefs("步骤1", "步骤2", "步骤3"));

        // 执行一些操作后再保存
        engine.markCurrentDone(cl, "步骤1完成");
        engine.markCurrentDone(cl, "步骤2完成");

        // 保存到临时目录
        JsonChecklistStore store = new JsonChecklistStore(tempDir);
        store.save(cl);

        // 重新加载
        Checklist loaded = store.findBySession("session-save");
        assertNotNull(loaded);

        // 验证各字段一致性
        assertEquals(cl.getId(), loaded.getId());
        assertEquals(cl.getSessionId(), loaded.getSessionId());
        assertEquals(cl.getWorkspaceHash(), loaded.getWorkspaceHash());
        assertEquals(cl.getTitle(), loaded.getTitle());
        assertEquals(cl.getDescription(), loaded.getDescription());
        assertEquals(cl.getStatus(), loaded.getStatus());
        assertEquals(cl.getCurrentStepIndex(), loaded.getCurrentStepIndex());

        // 验证步骤数量一致
        assertEquals(cl.getSteps().size(), loaded.getSteps().size());

        // 验证每个步骤的字段
        for (int i = 0; i < cl.getSteps().size(); i++) {
            ChecklistStep orig = cl.getSteps().get(i);
            ChecklistStep rest = loaded.getSteps().get(i);
            assertEquals(orig.getId(), rest.getId());
            assertEquals(orig.getDescription(), rest.getDescription());
            assertEquals(orig.getKind(), rest.getKind());
            assertEquals(orig.getStatus(), rest.getStatus());
            assertEquals(orig.getResult(), rest.getResult());
        }

        // 验证业务方法结果一致
        assertEquals(cl.isAllDone(), loaded.isAllDone());
        assertEquals(cl.hasFailed(), loaded.hasFailed());
        assertEquals(cl.isRunning(), loaded.isRunning());
        assertEquals(cl.progressText(), loaded.progressText());
    }

    @Test
    void testNoActiveStep() {
        // 创建没有步骤的清单
        Checklist cl = Checklist.builder()
                .id("no-step")
                .title("无步骤")
                .steps(new ArrayList<>())
                .currentStepIndex(0)
                .status("ACTIVE")
                .build();

        // currentStep() 应返回 null
        assertNull(cl.currentStep());

        // advance() 应返回 -1
        assertEquals(-1, cl.advance());

        // isAllDone() 应返回 true（零个步骤全部完成）
        assertTrue(cl.isAllDone());

        // hasFailed() 应返回 false
        assertFalse(cl.hasFailed());

        // progressText() 应显示 0/0 (0%)
        assertEquals("0/0 (0%)", cl.progressText());
    }
}
