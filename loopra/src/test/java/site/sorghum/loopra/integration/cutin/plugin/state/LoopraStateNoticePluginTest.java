package site.sorghum.loopra.integration.cutin.plugin.state;

import org.junit.jupiter.api.Test;
import site.sorghum.loopra.bin.agent.prompt.StateNoticeRenderer;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 状态通知插件的幂等判定测试 —— 用一个内存假宿主驱动，
 * 覆盖「不动作 / 追加 / 就地替换 / 清空 / 折叠后恢复」五条路径。
 */
class LoopraStateNoticePluginTest {

    /** 内存假宿主：用一条消息列表模拟会话历史。 */
    private static final class FakeHost implements LoopraStateNoticeHost {
        final List<String> history = new ArrayList<>();
        String body = "";
        boolean planMode = false;
        boolean subAgent = false;
        /** 模拟「模型已产出」：历史末尾追加一条 assistant 内容。 */
        boolean produced = false;

        @Override
        public String stateNoticeBody() {
            String goal = body == null ? "" : body;
            if (!planMode) {
                return goal;
            }
            return goal.isBlank()
                    ? StateNoticeRenderer.planModeBody(subAgent)
                    : goal + "\n\n" + StateNoticeRenderer.planModeBody(subAgent);
        }

        @Override
        public String appendStateNotice(String content) {
            history.add(content);
            produced = false;
            return StateNoticeRenderer.fingerprintOf(content);
        }

        @Override
        public String replaceLastStateNotice(String content) {
            for (int i = history.size() - 1; i >= 0; i--) {
                if (StateNoticeRenderer.isNotice(history.get(i))) {
                    history.set(i, content);
                    return StateNoticeRenderer.fingerprintOf(content);
                }
            }
            return null;
        }

        @Override
        public String lastStateNoticeFingerprint() {
            for (int i = history.size() - 1; i >= 0; i--) {
                String fingerprint = StateNoticeRenderer.fingerprintOf(history.get(i));
                if (fingerprint != null) {
                    return fingerprint;
                }
            }
            return null;
        }

        @Override
        public boolean modelProducedSinceLastNotice() {
            return produced;
        }

        @Override
        public boolean isPlanMode() {
            return planMode;
        }

        @Override
        public boolean isSubAgentLoop() {
            return subAgent;
        }
    }

    private static void step(FakeHost host) {
        new LoopraStateNoticePlugin(host).sync();
    }

    @Test
    void noStateAndNoNoticeInjectsNothing() {
        FakeHost host = new FakeHost();
        step(host);
        step(host);
        assertTrue(host.history.isEmpty(), "无状态时不应注入任何通知");
    }

    @Test
    void repeatedStepsWithSameStateAreByteIdentical() {
        FakeHost host = new FakeHost();
        host.body = "## 当前 Goal\n继续推进当前步骤。";

        step(host);
        assertEquals(1, host.history.size());
        String first = host.history.get(0);

        step(host);
        step(host);

        assertEquals(1, host.history.size(), "状态未变时不应重复注入");
        assertEquals(first, host.history.get(0), "状态未变时历史应逐字节相等");
    }

    @Test
    void stateChangeBeforeModelOutputReplacesInPlace() {
        FakeHost host = new FakeHost();
        host.body = "## 当前 Goal\n第一步";
        step(host);
        String before = host.history.get(0);

        host.body = "## 当前 Goal\n第二步";
        step(host);

        assertEquals(1, host.history.size(), "模型尚未产出时就地更新，不追加");
        assertNotEquals(before, host.history.get(0));
        assertEquals(StateNoticeRenderer.fingerprint(host.body), host.lastStateNoticeFingerprint());
    }

    @Test
    void stateChangeAfterModelOutputAppends() {
        FakeHost host = new FakeHost();
        host.body = "## 当前 Goal\n第一步";
        step(host);

        // 模型产出了一条 assistant 回复，随后状态又变了
        host.produced = true;
        host.body = "## 当前 Goal\n第二步";
        step(host);

        assertEquals(2, host.history.size(), "模型已产出后应追加新通知");
        assertEquals(StateNoticeRenderer.fingerprint(host.body), host.lastStateNoticeFingerprint());
    }

    @Test
    void clearingStateEmitsSingleClearedNotice() {
        FakeHost host = new FakeHost();
        host.body = "## 当前 Goal\n进行中";
        step(host);

        host.produced = true;
        host.body = "";
        step(host);
        assertEquals(2, host.history.size());
        assertEquals(StateNoticeRenderer.CLEARED_FINGERPRINT, host.lastStateNoticeFingerprint());

        // 清空通知只发一次：后续轮次期望状态与现存指纹一致
        step(host);
        step(host);
        assertEquals(2, host.history.size(), "清空通知不应重复注入");
    }

    @Test
    void noticeIsReInjectedAfterBeingDroppedByCompaction() {
        FakeHost host = new FakeHost();
        host.body = "## 当前 Goal\n进行中";
        step(host);
        assertEquals(1, host.history.size());

        // 模拟折叠：整段历史被摘要替换，通知消失
        host.history.clear();
        host.produced = true;

        step(host);
        assertEquals(1, host.history.size(), "通知被折叠吞掉后应自动重新注入");
        assertEquals(StateNoticeRenderer.fingerprint(host.body), host.lastStateNoticeFingerprint());
    }

    @Test
    void planModeAloneIsInjectedWithoutGoal() {
        FakeHost host = new FakeHost();
        host.planMode = true;
        step(host);

        assertEquals(1, host.history.size());
        assertTrue(host.history.get(0).contains("计划模式"));
        assertTrue(host.history.get(0).contains("submit_plan"));
    }

    @Test
    void subAgentPlanNoticeOmitsSubmitPlan() {
        FakeHost host = new FakeHost();
        host.planMode = true;
        host.subAgent = true;
        step(host);

        assertEquals(1, host.history.size());
        assertTrue(host.history.get(0).contains("计划模式"));
        assertTrue(!host.history.get(0).contains("submit_plan"),
                "子代理没有 submit_plan 工具，不应被指引去提交计划");
    }

    @Test
    void togglingPlanModeBackAndForthKeepsHistoryBounded() {
        FakeHost host = new FakeHost();
        for (int i = 0; i < 6; i++) {
            host.planMode = !host.planMode;
            step(host);
        }
        // 模型始终没有产出，因此每次切换都是就地替换，历史只有一条通知
        assertEquals(1, host.history.size(), "模型未产出时反复切换不应堆积通知");
    }
}
