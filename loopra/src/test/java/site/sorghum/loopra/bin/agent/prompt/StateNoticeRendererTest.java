package site.sorghum.loopra.bin.agent.prompt;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class StateNoticeRendererTest {

    private static final String GOAL_BODY = "## 当前 Goal\n继续推进当前步骤。";

    @Test
    void renderIsStableForSameBody() {
        assertEquals(StateNoticeRenderer.render(GOAL_BODY), StateNoticeRenderer.render(GOAL_BODY));
    }

    @Test
    void renderIgnoresSurroundingWhitespace() {
        assertEquals(StateNoticeRenderer.render(GOAL_BODY),
                StateNoticeRenderer.render("\n  " + GOAL_BODY + "  \n"));
    }

    @Test
    void differentBodiesProduceDifferentFingerprints() {
        assertNotEquals(StateNoticeRenderer.fingerprint(GOAL_BODY),
                StateNoticeRenderer.fingerprint(GOAL_BODY + "\n新增一步"));
    }

    @Test
    void blankBodyProducesNoNotice() {
        assertEquals("", StateNoticeRenderer.render(null));
        assertEquals("", StateNoticeRenderer.render(""));
        assertEquals("", StateNoticeRenderer.render("   \n  "));
    }

    @Test
    void fingerprintRoundTripsThroughRenderedText() {
        String rendered = StateNoticeRenderer.render(GOAL_BODY);
        assertEquals(StateNoticeRenderer.fingerprint(GOAL_BODY),
                StateNoticeRenderer.fingerprintOf(rendered));
        assertTrue(StateNoticeRenderer.isNotice(rendered));
    }

    @Test
    void clearedNoticeHasFixedFingerprint() {
        String first = StateNoticeRenderer.renderCleared();
        String second = StateNoticeRenderer.renderCleared();
        assertEquals(first, second);
        assertEquals(StateNoticeRenderer.CLEARED_FINGERPRINT, StateNoticeRenderer.fingerprintOf(first));
        // 清空指纹与任何真实状态指纹都不同，避免误判为「已同步」
        assertNotEquals(StateNoticeRenderer.CLEARED_FINGERPRINT, StateNoticeRenderer.fingerprint(GOAL_BODY));
    }

    @Test
    void noticeCarriesHygieneTail() {
        String rendered = StateNoticeRenderer.render(GOAL_BODY);
        assertTrue(rendered.contains("不是用户的新指令"), "缺少卫生尾巴");
        assertTrue(rendered.contains("不要向用户复述"), "缺少卫生尾巴");
        assertTrue(rendered.startsWith("<system-reminder source=\"loopra-state\""));
        assertTrue(rendered.endsWith("</system-reminder>"));
    }

    @Test
    void plainMessageIsNotANotice() {
        assertNull(StateNoticeRenderer.fingerprintOf("普通用户消息"));
        assertNull(StateNoticeRenderer.fingerprintOf(null));
        assertFalse(StateNoticeRenderer.isNotice("普通用户消息"));
        // 只提 source 但没有 fingerprint 属性 → 不是本渲染器产出
        assertFalse(StateNoticeRenderer.isNotice("<system-reminder source=\"loopra-state\">x</system-reminder>"));
    }
}
