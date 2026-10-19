package site.sorghum.loopra.web.controller;

import org.junit.jupiter.api.Test;
import site.sorghum.loopra.web.model.SessionInfoDTO;
import site.sorghum.loopra.web.service.AgentService;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * 会话排序合并逻辑单元测试。
 * <p>
 * 验证 {@link AgentService#applySessionOrder(List, List)}：
 * 已保存排序的会话按顺序排列，新会话保留在顶部，已删除的会话名被忽略。
 */
class SessionOrderTest {

    private static SessionInfoDTO session(String name) {
        return new SessionInfoDTO(name, "title-" + name, 0, false, 0, false);
    }

    private static List<String> names(List<SessionInfoDTO> sessions) {
        List<String> result = new ArrayList<>();
        for (SessionInfoDTO session : sessions) {
            result.add(session.name());
        }
        return result;
    }

    @Test
    void emptyOrderKeepsTheOriginalList() {
        List<SessionInfoDTO> sessions = Arrays.asList(session("a"), session("b"), session("c"));
        assertEquals(sessions, AgentService.applySessionOrder(sessions, Collections.emptyList()));
        assertEquals(sessions, AgentService.applySessionOrder(sessions, null));
    }

    @Test
    void savedOrderIsAppliedAndDeletedNamesAreIgnored() {
        List<SessionInfoDTO> sessions = Arrays.asList(session("a"), session("b"), session("c"));
        assertEquals(Arrays.asList("c", "a", "b"),
                names(AgentService.applySessionOrder(sessions, Arrays.asList("c", "gone", "a", "b"))));
    }

    @Test
    void newlyCreatedSessionsStayAtTheTop() {
        // list() already returns newest first; a saved order never contains a session
        // created after the last drag, and that session must remain at the top.
        List<SessionInfoDTO> sessions = Arrays.asList(session("fresh"), session("a"), session("b"), session("c"));
        assertEquals(Arrays.asList("fresh", "c", "a", "b"),
                names(AgentService.applySessionOrder(sessions, Arrays.asList("c", "a", "b"))));
    }
}
