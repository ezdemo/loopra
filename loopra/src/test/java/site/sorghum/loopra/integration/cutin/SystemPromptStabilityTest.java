package site.sorghum.loopra.integration.cutin;

import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;
import site.sorghum.cutin.core.context.Message;
import site.sorghum.cutin.core.model.ModelCallRequest;
import site.sorghum.loopra.bin.agent.context.ConversationContext;
import site.sorghum.loopra.bin.agent.core.AgentLoop;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.bin.agent.prompt.PromptPrefix;
import site.sorghum.loopra.bin.agent.prompt.StateNoticeRenderer;
import site.sorghum.loopra.bin.model.TestLoopraProvider;
import site.sorghum.loopra.bin.tool.ToolRegistry;
import site.sorghum.loopra.tool.AgentOutput;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 前缀缓存的核心断言：Goal 与计划模式来回切换时，
 * 发给模型的 system 必须逐字节恒定 —— 易变状态改走历史里的状态通知。
 */
class SystemPromptStabilityTest {

    /** 每轮记录一次 system 文本。 */
    private static final class Recorder {
        final List<String> systems = new ArrayList<>();

        void record(ModelCallRequest request) {
            request.messages().stream()
                    .filter(m -> "system".equals(m.role()))
                    .map(Message::content)
                    .findFirst()
                    .ifPresent(systems::add);
        }
    }

    @Test
    void systemStaysByteIdenticalAcrossStateChanges() throws Exception {
        Recorder recorder = new Recorder();
        AtomicInteger calls = new AtomicInteger();
        TestLoopraProvider client = TestLoopraProvider.builder()
                .model("test-model")
                .stream(request -> {
                    recorder.record(request);
                    return TestLoopraProvider.contentStream("回复 " + calls.incrementAndGet());
                })
                .build();

        ConversationContext context = new ConversationContext(
                new PromptPrefix("system", new ONode().asArray()));
        AgentLoop loop = new AgentLoop(
                client, new ToolRegistry().setDisabledTools(Set.of()), context, null);
        loop.freezePromptPrefix();
        loop.setOutput(AgentOutput.NOOP);

        loop.run(UserMessage.of("第一轮"));
        loop.setPlanMode(true);
        loop.run(UserMessage.of("第二轮"));
        loop.setPlanMode(false);
        loop.run(UserMessage.of("第三轮"));

        assertTrue(recorder.systems.size() >= 3, "应至少记录三轮 system");
        String baseline = recorder.systems.get(0);
        for (String system : recorder.systems) {
            assertEquals(baseline, system, "状态切换不得改变 system（前缀缓存命中的前提）");
        }
    }

    @Test
    void stateChangesLandInHistoryAsHiddenNotices() throws Exception {
        Recorder recorder = new Recorder();
        List<List<Message>> requests = new ArrayList<>();
        TestLoopraProvider client = TestLoopraProvider.builder()
                .model("test-model")
                .stream(request -> {
                    recorder.record(request);
                    requests.add(request.messages());
                    return TestLoopraProvider.contentStream("ok");
                })
                .build();

        ConversationContext context = new ConversationContext(
                new PromptPrefix("system", new ONode().asArray()));
        AgentLoop loop = new AgentLoop(
                client, new ToolRegistry().setDisabledTools(Set.of()), context, null);
        loop.freezePromptPrefix();
        loop.setOutput(AgentOutput.NOOP);

        loop.run(UserMessage.of("普通提问"));
        loop.setPlanMode(true);
        loop.run(UserMessage.of("进入计划模式"));

        // 计划模式通知必须出现在最后一次请求的历史里，且不是 system 角色
        List<Message> last = requests.get(requests.size() - 1);
        boolean noticeInHistory = last.stream()
                .filter(m -> !"system".equals(m.role()))
                .anyMatch(m -> StateNoticeRenderer.isNotice(m.content()));
        assertTrue(noticeInHistory, "计划模式应作为历史中的状态通知送达模型");
    }

    @Test
    void stateNoticeNeverBecomesTopLevelSystemField() throws Exception {
        Recorder recorder = new Recorder();
        TestLoopraProvider client = TestLoopraProvider.builder()
                .model("test-model")
                .stream(request -> {
                    recorder.record(request);
                    return TestLoopraProvider.contentStream("ok");
                })
                .build();

        ConversationContext context = new ConversationContext(
                new PromptPrefix("system", new ONode().asArray()));
        AgentLoop loop = new AgentLoop(
                client, new ToolRegistry().setDisabledTools(Set.of()), context, null);
        loop.freezePromptPrefix();
        loop.setOutput(AgentOutput.NOOP);

        loop.setPlanMode(true);
        loop.run(UserMessage.of("计划"));

        for (String system : recorder.systems) {
            assertTrue(!StateNoticeRenderer.isNotice(system),
                    "状态通知绝不能出现在顶层 system 字段里");
        }
    }

    @Test
    void hiddenNoticeDoesNotAppearAsVisibleUserBubble() throws Exception {
        TestLoopraProvider client = TestLoopraProvider.builder()
                .model("test-model")
                .stream(request -> TestLoopraProvider.contentStream("ok"))
                .build();

        ConversationContext context = new ConversationContext(
                new PromptPrefix("system", new ONode().asArray()));
        AgentLoop loop = new AgentLoop(
                client, new ToolRegistry().setDisabledTools(Set.of()), context, null);
        loop.freezePromptPrefix();
        loop.setOutput(AgentOutput.NOOP);

        loop.setPlanMode(true);
        loop.run(UserMessage.of("计划"));

        long visibleNotices = context.getHistory().stream()
                .filter(m -> StateNoticeRenderer.isNotice(m.getContent()))
                .filter(m -> !m.isWebHidden())
                .count();
        assertEquals(0, visibleNotices, "状态通知必须带 webHidden，否则会在 Web 界面显示成用户气泡");

        long hiddenNotices = context.getHistory().stream()
                .filter(m -> StateNoticeRenderer.isNotice(m.getContent()))
                .filter(m -> m.isWebHidden())
                .count();
        assertTrue(hiddenNotices >= 1, "计划模式应产生一条 webHidden 通知");
    }

    @Test
    void distinctStatesProduceDistinctFingerprints() {
        String planOn = StateNoticeRenderer.planModeBody(false);
        String planOff = StateNoticeRenderer.CLEARED_FINGERPRINT;
        assertNotEquals(StateNoticeRenderer.fingerprint(planOn), planOff);
    }
}
