package site.sorghum.loopra.integration.cutin;

import site.sorghum.cutin.core.context.Message;
import site.sorghum.cutin.core.tool.ToolCall;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.model.ToolCallEntry;
import site.sorghum.loopra.bin.agent.model.UserMessage;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static site.sorghum.loopra.bin.agent.model.ToolCallEntry.parseArguments;

/**
  * Loopra 公共 {@link ChatMessage} 模型与 cutin 不可变 {@link Message} 模型之间的消息转换。
 */
public final class CutinMessageBridge {

    private CutinMessageBridge() {
    }

    public static List<Message> toCutin(List<ChatMessage> messages) {
        List<Message> result = new ArrayList<>(messages.size());
        for (ChatMessage message : messages) {
            result.add(toCutin(message));
        }
        return result;
    }

    public static Message toCutin(ChatMessage message) {
        if (message.isTool()) {
            Map<String, Object> metadata = new HashMap<>();
            if (message.getToolImageUrl() != null && !message.getToolImageUrl().isBlank()) {
                metadata.put("tool_image_url", message.getToolImageUrl());
            }
            return new Message(
                "tool",
                message.getContent(),
                message.getToolCallId(),
                List.of(),
                metadata
            );
        }
        if (message.isAssistant()) {
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
            if (message.getToolImageUrl() != null && !message.getToolImageUrl().isBlank()) {
                metadata.put("tool_image_url", message.getToolImageUrl());
            }
            return new Message(
                "assistant",
                message.getContent(),
                null,
                toCutinToolCalls(message.getToolCalls()),
                metadata
            );
        }
        // user 及其他角色：兼容 contentParts 多模态模式（text part → content，
        // image_url part → metadata.images），与 toCutin(UserMessage) 语义一致，
        // 避免 compaction 整体覆盖时丢图片/文本。
        List<ChatMessage.ContentPart> parts = message.getContentParts();
        if (parts != null && !parts.isEmpty()) {
            StringBuilder text = new StringBuilder();
            List<String> images = new ArrayList<>();
            for (ChatMessage.ContentPart part : parts) {
                if ("text".equals(part.getType()) && part.getText() != null) {
                    if (text.length() > 0) {
                        text.append('\n');
                    }
                    text.append(part.getText());
                } else if ("image_url".equals(part.getType())
                        && part.getImageUrl() != null
                        && part.getImageUrl().getUrl() != null) {
                    images.add(part.getImageUrl().getUrl());
                }
            }
            Map<String, Object> metadata = new HashMap<>();
            if (!images.isEmpty()) {
                metadata.put("images", List.copyOf(images));
            }
            return new Message(
                message.getRole(),
                text.length() == 0 ? null : text.toString(),
                null,
                List.of(),
                metadata
            );
        }
        return new Message(
            message.getRole(),
            message.getContent(),
            null,
            List.of()
        );
    }

    /** 把回合级用户消息转换为 Cutin 消息，并保留图片元数据。 */
    public static Message toCutin(UserMessage message) {
        Map<String, Object> metadata = new HashMap<>();
        if (message != null && message.hasImages()) {
            metadata.put("images", List.copyOf(message.getImages()));
        }
        return new Message(
            "user",
            message == null ? null : message.getText(),
            null,
            List.of(),
            metadata
        );
    }

    public static List<ChatMessage> toLoopra(List<Message> messages) {
        List<ChatMessage> result = new ArrayList<>(messages.size());
        for (Message message : messages) {
            switch (message.role()) {
                case "system" -> result.add(ChatMessage.ofSystem(message.content()));
                case "user" -> result.add(toLoopraUser(message));
                case "assistant" -> result.add(toLoopraAssistant(message));
                case "tool" -> result.add(ChatMessage.tool(
                    message.toolCallId(),
                    message.content()
                ));
                default -> result.add(ChatMessage.ofUser(message.content()));
            }
        }
        return result;
    }

    private static ChatMessage toLoopraUser(Message message) {
        Object images = message.metadata("images");
        if (images instanceof List<?> list && !list.isEmpty()) {
            List<String> urls = list.stream().map(String::valueOf).toList();
            return ChatMessage.ofUser(message.content(), urls);
        }
        return ChatMessage.ofUser(message.content());
    }

    private static ChatMessage toLoopraAssistant(Message message) {
        ChatMessage assistant = ChatMessage.assistant(
            message.content(),
            toLoopraToolCalls(message.toolCalls()),
            metadataString(message, "reasoning_content")
        );
        Object blocks = message.metadata("thinking_blocks");
        if (blocks instanceof List<?> list && !list.isEmpty()) {
            java.util.List<String> strings = new ArrayList<>();
            for (Object block : list) {
                strings.add(block == null ? "" : String.valueOf(block));
            }
            assistant.setThinkingBlocks(strings);
        }
        Object responseReasoning = message.metadata("response_reasoning");
        if (responseReasoning != null) {
            assistant.setResponseReasoning(String.valueOf(responseReasoning));
        }
        return assistant;
    }

    private static String metadataString(Message message, String key) {
        Object value = message.metadata(key);
        return value == null ? null : String.valueOf(value);
    }

    private static List<ToolCall> toCutinToolCalls(List<ToolCallEntry> entries) {
        if (entries == null || entries.isEmpty()) {
            return List.of();
        }
        List<ToolCall> result = new ArrayList<>(entries.size());
        for (ToolCallEntry entry : entries) {
            result.add(new ToolCall(
                entry.id(),
                entry.name(),
                parseArguments(entry.arguments()),
                entry.id()
            ));
        }
        return result;
    }

    private static List<ToolCallEntry> toLoopraToolCalls(List<ToolCall> calls) {
        if (calls == null || calls.isEmpty()) {
            return List.of();
        }
        List<ToolCallEntry> result = new ArrayList<>(calls.size());
        for (ToolCall call : calls) {
            result.add(new ToolCallEntry(
                call.id(),
                call.toolId(),
                call.arguments()
            ));
        }
        return result;
    }

}
