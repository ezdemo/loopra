package site.sorghum.loopra.bin.agent.context;

import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.model.ToolCallEntry;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class MessageHealerTest {

    @Test
    void deduplicatesCallIdsAcrossAssistantMessagesAndKeepsResultPairing() {
        List<ChatMessage> dirty = List.of(
            ChatMessage.ofUser("start"),
            ChatMessage.assistant(null,
                List.of(new ToolCallEntry("call-1", "bash", "{}")), null),
            ChatMessage.tool("call-1", "timeout-1"),
            ChatMessage.assistant(null,
                List.of(new ToolCallEntry("call-1", "bash", "{}")), null),
            // 旧版清洗器只给第二个 tool 结果加了后缀，assistant call 仍然重复；
            // 这里复现实际日志中的半清洗状态。
            ChatMessage.tool("call-1_dedup_0", "timeout-2")
        );

        MessageHealer.HealResult result = MessageHealer.heal(dirty);

        assertEquals(List.of("call-1", "call-1_dedup_0"), assistantCallIds(result.messages()));
        assertEquals(List.of("call-1", "call-1_dedup_0"), toolResultIds(result.messages()));
        assertEquals(List.of("timeout-1", "timeout-2"), toolResultContents(result.messages()));
        assertTrue(result.changed());
    }

    @Test
    void dropsOrphanToolResultsAfterDuplicateBatchWasConsumed() {
        List<ChatMessage> dirty = List.of(
            ChatMessage.assistant(null,
                List.of(new ToolCallEntry("call-1", "bash", "{}")), null),
            ChatMessage.tool("call-1", "ok"),
            ChatMessage.tool("call-1", "duplicate")
        );

        MessageHealer.HealResult result = MessageHealer.heal(dirty);

        assertEquals(2, result.messages().size());
        assertEquals("ok", result.messages().get(1).getContent());
        assertTrue(result.changed());
    }

    @Test
    void normalizesNewResponseAgainstExistingHistory() {
        List<ChatMessage> history = List.of(
            ChatMessage.assistant(null,
                List.of(new ToolCallEntry("call-1", "bash", "{}")), null),
            ChatMessage.tool("call-1", "ok")
        );
        ONode raw = ONode.ofJson("[{\"id\":\"call-1\"},{\"id\":\"call-1\"}]").asArray();

        ONode normalized = MessageHealer.normalizeIncomingToolCallIds(raw, history);

        assertEquals("call-1_dedup_0", normalized.get(0).get("id").getString());
        assertEquals("call-1_dedup_1", normalized.get(1).get("id").getString());
    }

    private static List<String> assistantCallIds(List<ChatMessage> messages) {
        return messages.stream()
            .filter(ChatMessage::isAssistant)
            .flatMap(message -> message.getToolCalls().stream())
            .map(ToolCallEntry::id)
            .toList();
    }

    private static List<String> toolResultIds(List<ChatMessage> messages) {
        return messages.stream()
            .filter(ChatMessage::isTool)
            .map(ChatMessage::getToolCallId)
            .toList();
    }

    private static List<String> toolResultContents(List<ChatMessage> messages) {
        return messages.stream()
            .filter(ChatMessage::isTool)
            .map(ChatMessage::getContent)
            .toList();
    }
}
