package site.sorghum.loopra.bin.model;

import site.sorghum.cutin.core.context.Message;
import site.sorghum.cutin.core.tool.ToolCall;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.model.ToolCallEntry;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static site.sorghum.loopra.bin.agent.model.ToolCallEntry.parseArguments;

/** Loopra 消息与 Cutin Message 之间的双向转换工具。 */
final class CutinModelMessages {

    private CutinModelMessages() {
    }

    static List<Message> toCutin(List<ChatMessage> messages) {
        List<Message> result = new ArrayList<>(messages.size());
        for (ChatMessage message : messages) {
            result.add(toCutin(message));
        }
        return result;
    }

    static Message toCutin(ChatMessage message) {
        Map<String, Object> metadata = new HashMap<>();
        if (message.getReasoningContent() != null) {
            metadata.put("reasoning_content", message.getReasoningContent());
        }
        if (message.getThinkingBlocks() != null && !message.getThinkingBlocks().isEmpty()) {
            metadata.put("thinking_blocks", List.copyOf(message.getThinkingBlocks()));
        }
        if (message.getResponseReasoning() != null) {
            metadata.put("response_reasoning", message.getResponseReasoning());
        }
        if (message.getContentParts() != null && !message.getContentParts().isEmpty()) {
            List<Map<String, Object>> parts = new ArrayList<>();
            for (ChatMessage.ContentPart part : message.getContentParts()) {
                Map<String, Object> partMap = new HashMap<>();
                partMap.put("type", part.getType());
                if ("text".equals(part.getType())) {
                    partMap.put("text", part.getText());
                } else if ("image_url".equals(part.getType()) && part.getImageUrl() != null) {
                    Map<String, Object> image = new HashMap<>();
                    image.put("url", part.getImageUrl().getUrl());
                    if (part.getImageUrl().getDetail() != null) {
                        image.put("detail", part.getImageUrl().getDetail());
                    }
                    partMap.put("image_url", image);
                }
                parts.add(partMap);
            }
            metadata.put("content_parts", List.copyOf(parts));
        }
        if (message.getToolImageUrl() != null) {
            metadata.put("tool_image_url", message.getToolImageUrl());
            metadata.put("tool_image_detail", message.getToolImageDetail());
        }

        if (message.isTool()) {
            return new Message("tool", message.getContent(), message.getToolCallId(), List.of(), metadata);
        }
        if (message.isAssistant()) {
            return new Message(
                "assistant",
                message.getContent(),
                null,
                toCutinToolCalls(message.getToolCalls()),
                metadata
            );
        }
        return new Message(message.getRole(), message.getContent(), null, List.of(), metadata);
    }

    private static List<ToolCall> toCutinToolCalls(List<ToolCallEntry> entries) {
        if (entries == null || entries.isEmpty()) {
            return List.of();
        }
        List<ToolCall> calls = new ArrayList<>(entries.size());
        for (ToolCallEntry entry : entries) {
            calls.add(new ToolCall(
                entry.id(),
                entry.name(),
                parseArguments(entry.arguments()),
                entry.id()
            ));
        }
        return calls;
    }

}
