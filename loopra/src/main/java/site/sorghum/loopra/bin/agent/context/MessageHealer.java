package site.sorghum.loopra.bin.agent.context;

import org.noear.snack4.ONode;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.model.ToolCallEntry;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/**
 * Loopra 消息整流器。
 *
 * <p>工具调用 ID 分配、assistant/tool 配对等协议无关逻辑由
 * {@link ToolCallMessageHealer} 统一维护；本类只负责 ChatMessage 的适配、
 * reasoning_content 补齐和超大 tool 结果裁剪。</p>
 */
public class MessageHealer {

    /** 整流结果：修复后的消息列表 + 是否发生了修改。 */
    public record HealResult(List<ChatMessage> messages, boolean changed) {
    }

    /**
     * 为即将执行的全新模型工具调用分配当前上下文内唯一的 ID。
     *
     * <p>模型在超时后继续推理时，偶尔会把上一轮的 call id 原样重放。
     * 这类调用尚未进入历史，不能使用 {@link #heal(List)} 的配对逻辑，
     * 因此在执行工具前单独做一次 ID 归一化。</p>
     */
    public static ONode normalizeIncomingToolCallIds(ONode toolCalls, List<ChatMessage> history) {
        return ToolCallMessageHealer.normalizeIncomingToolCallIds(
                toolCalls, knownCallIds(history));
    }

    /**
     * 对消息列表执行全部 ChatMessage 相关修复。
     *
     * <p>工具调用 ID 在整批消息中保持唯一，tool 结果按真实 ID 配对；
     * 缺失 reasoning_content 和过大的 tool 输出则由 Loopra 模型层兼容处理。</p>
     */
    public static HealResult heal(List<ChatMessage> messages) {
        ToolCallMessageHealer.HealResult<ChatMessage> healed =
                ToolCallMessageHealer.heal(messages, CHAT_MESSAGE_ADAPTER);
        List<ChatMessage> stamped = new ArrayList<>(healed.messages().size());
        for (ChatMessage message : healed.messages()) {
            stamped.add(stampMissingReasoning(message));
        }
        return new HealResult(stamped, healed.changed());
    }

    private static final ToolCallMessageHealer.Adapter<ChatMessage, ToolCallEntry>
            CHAT_MESSAGE_ADAPTER = new ToolCallMessageHealer.Adapter<>() {
        @Override
        public String role(ChatMessage message) {
            return message.getRole();
        }

        @Override
        public String content(ChatMessage message) {
            return message.getContent();
        }

        @Override
        public String toolCallId(ChatMessage message) {
            return message.getToolCallId();
        }

        @Override
        public List<ToolCallEntry> toolCalls(ChatMessage message) {
            return message.getToolCalls() == null ? List.of() : message.getToolCalls();
        }

        @Override
        public boolean isUsableToolCall(ToolCallEntry call) {
            return call != null && call.name() != null && !call.name().isBlank();
        }

        @Override
        public String callId(ToolCallEntry call) {
            return call.id();
        }

        @Override
        public ToolCallEntry withToolCallId(ToolCallEntry call, String id) {
            return new ToolCallEntry(id, call.name(), call.arguments(), call.responseReasoning());
        }

        @Override
        public ToolCallMessageHealer.NormalizedCall<ToolCallEntry> normalizeCall(
                ToolCallEntry call,
                String normalizedId
        ) {
            Object arguments = call.arguments();
            boolean changed = !Objects.equals(call.id(), normalizedId);
            if (arguments instanceof String argStr) {
                try {
                    ONode.ofJson(argStr).toJson();
                } catch (Exception ignored) {
                    arguments = "{}";
                    changed = true;
                }
            }
            changed |= !Objects.equals(call.arguments(), arguments);
            return new ToolCallMessageHealer.NormalizedCall<>(
                    new ToolCallEntry(
                            normalizedId,
                            call.name(),
                            arguments,
                            call.responseReasoning()),
                    changed);
        }

        @Override
        public ChatMessage withToolCalls(ChatMessage message, List<ToolCallEntry> calls) {
            ChatMessage copy = message.copy();
            copy.setToolCalls(calls);
            return copy;
        }

        @Override
        public ChatMessage withMessageToolCallId(ChatMessage message, String id) {
            ChatMessage copy = message.copy();
            copy.setToolCallId(id);
            return copy;
        }

        @Override
        public ChatMessage withContent(ChatMessage message, String content) {
            ChatMessage copy = message.copy();
            copy.setContent(content);
            return copy;
        }

        @Override
        public ChatMessage normalizeToolResult(ChatMessage message) {
            String content = message.getContent();
            if (content == null || content.length() <= 16_000) {
                return message;
            }
            int keepLen = Math.min(12_000, content.length() / 2);
            String truncated = content.substring(0, keepLen)
                    + "\n\n[truncated: 原文 " + content.length()
                    + " 字符，已截断至 " + keepLen + " 字符]";
            return withContent(message, truncated);
        }
    };

    /** 为 assistant 补齐模型兼容字段；补空 reasoning 不计入 changed。 */
    private static ChatMessage stampMissingReasoning(ChatMessage message) {
        if (!"assistant".equals(message.getRole()) || message.getReasoningContent() != null) {
            return message;
        }
        ChatMessage stamped = message.copy();
        if (!stamped.hasToolCalls() && !stamped.hasContent() && stamped.getContent() == null) {
            stamped.setContent("");
        }
        stamped.setReasoningContent("");
        return stamped;
    }

    /** 收集上下文中已占用的调用 ID，供新模型响应分配唯一 ID。 */
    private static Set<String> knownCallIds(List<ChatMessage> messages) {
        Set<String> ids = new HashSet<>();
        if (messages == null) {
            return ids;
        }
        for (ChatMessage message : messages) {
            if (message == null) {
                continue;
            }
            if (message.isAssistant() && message.getToolCalls() != null) {
                for (ToolCallEntry call : message.getToolCalls()) {
                    if (call != null) {
                        String id = normalizeId(call.id());
                        if (id != null) {
                            ids.add(id);
                        }
                    }
                }
            } else if (message.isTool()) {
                String id = normalizeId(message.getToolCallId());
                if (id != null) {
                    ids.add(id);
                }
            }
        }
        return ids;
    }

    private static String normalizeId(String id) {
        return id == null || id.isBlank() ? null : id;
    }
}
