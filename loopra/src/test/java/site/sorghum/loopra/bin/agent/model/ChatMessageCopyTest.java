package site.sorghum.loopra.bin.agent.model;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ChatMessageCopyTest {

    @Test
    void copyPreservesWebHidden() {
        ChatMessage notice = ChatMessage.ofUser("系统状态通知");
        notice.setWebHidden(true);

        assertTrue(notice.copy().isWebHidden());
    }

    @Test
    void copyKeepsWebHiddenFalseForOrdinaryMessages() {
        ChatMessage plain = ChatMessage.ofUser("普通消息");

        assertFalse(plain.copy().isWebHidden());
    }

    @Test
    void copyPreservesIdentityFields() {
        ChatMessage original = ChatMessage.ofUser("x");
        original.setSnapshotId("snap-1");
        original.setRollbackId("rollback-1");
        original.setWebHidden(true);
        original.setTimestamp(1234L);

        ChatMessage copy = original.copy();

        assertEquals("user", copy.getRole());
        assertEquals("x", copy.getContent());
        assertEquals("snap-1", copy.getSnapshotId());
        assertEquals("rollback-1", copy.getRollbackId());
        assertEquals(1234L, copy.getTimestamp());
    }

    @Test
    void copyDetachesMutableLists() {
        ChatMessage original = ChatMessage.ofUser("x");
        original.setThinkingBlocks(new java.util.ArrayList<>(List.of("{\"type\":\"thinking\"}")));

        ChatMessage copy = original.copy();
        copy.getThinkingBlocks().add("{\"type\":\"thinking\",\"n\":2}");

        assertEquals(1, original.getThinkingBlocks().size(), "副本修改不应回写原消息");
    }
}
