package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Test;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.model.FileChange;
import site.sorghum.loopra.bin.agent.model.ToolCallEntry;
import site.sorghum.loopra.web.common.ServiceException;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class AcpForkPointTest {
    @SuppressWarnings("unchecked")
    private Map<String, Object> point(AcpForkPoint fork) {
        return (Map<String, Object>) ((Map<?, ?>) ((Map<?, ?>) fork.meta().get("jetbrains")).get("air")).get("fork");
    }

    @Test void usesThePersistedRemoteIdentityAndCopiesOnlyTheSelectedPrefix() {
        var answer = ChatMessage.assistant("selected", null, null);
        answer.setAcpMessageId("remote-message");
        var source = List.of(ChatMessage.ofUser("first"), answer, ChatMessage.ofUser("future"),
                ChatMessage.assistant("must not be inherited", null, null));
        var fork = AcpForkPoint.at(source, 2);
        assertEquals(source.subList(0, 2), fork.history());
        assertEquals("remote-message", point(fork).get("messageId"));
        assertEquals(1, point(fork).get("version"));
        assertEquals(4, source.size());
    }

    @Test void legacyRecordsUseAnExactFingerprintAndCountRepeatedReplies() {
        var source = List.of(ChatMessage.ofUser("first"), ChatMessage.assistant("hello", null, null),
                ChatMessage.ofUser("second"), ChatMessage.assistant("hello", null, null),
                ChatMessage.ofUser("future"));
        var point = point(AcpForkPoint.at(source, 4));
        assertEquals("loopra-history-4", point.get("messageId"));
        assertEquals("sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
                point.get("messageFingerprint"));
        assertEquals(2, point.get("messageOccurrence"));
    }

    @Test void trailingFileSummariesDoNotHideTheFinalRemoteMessage() {
        var answer = ChatMessage.assistant("done", null, null);
        answer.setAcpMessageId("remote-final");
        var files = ChatMessage.assistant(null, null, null);
        files.setFileChanges(List.of(new FileChange("test.txt", 1, 0, true, "")));
        var fork = AcpForkPoint.at(List.of(ChatMessage.ofUser("edit"), answer, files), 3);
        assertEquals(3, fork.history().size());
        assertEquals("remote-final", point(fork).get("messageId"));
    }

    @Test void rejectsMidTurnUserOnlyAndToolOnlyBoundaries() {
        var user = ChatMessage.ofUser("question");
        var answer = ChatMessage.assistant("done", null, null);
        assertThrows(ServiceException.class, () -> AcpForkPoint.at(List.of(user, answer, answer), 2));
        assertThrows(ServiceException.class, () -> AcpForkPoint.at(List.of(user), 1));
        var toolCall = ChatMessage.assistant(null, List.of(new ToolCallEntry("tool", "read", "{}")), null);
        assertThrows(ServiceException.class, () -> AcpForkPoint.at(List.of(user, toolCall, ChatMessage.tool("tool", "done")), 3));
        assertThrows(ServiceException.class, () -> AcpForkPoint.at(List.of(user, answer), 3));
    }
}
