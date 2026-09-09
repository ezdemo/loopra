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
 * 消息修复器（整流器）—— 发送前修复消息列表。
 * <p>
 * 消息修复单次遍历完成，直接操作 {@link ChatMessage} 对象，
 * 避免 ChatMessage ↔ Map 的序列化/反序列化往返。
 * <ol>
 *   <li><b>fixToolCallPairing</b> — 修复不完整 tool_calls/tool 对</li>
 *   <li><b>stampMissingReasoning</b> — 为 thinking 模型补全 reasoning_content</li>
 *   <li><b>dedupToolCallId</b> — 检测并修复重复的 tool_call_id（兜底防护）</li>
 *   <li><b>dedupToolCallArrayId</b> — 检测并修复 tool_calls 数组内的重复 id</li>
 * </ol>
 * </p>
 *
 * @author Sorghum
 */
public class MessageHealer {

    /**
     * 整流结果：修复后的消息列表 + 是否发生了修改。
     */
    public record HealResult(List<ChatMessage> messages, boolean changed) {}

    /**
     * 为即将执行的全新模型工具调用分配当前上下文内唯一的 ID。
     *
     * <p>模型在超时后继续推理时，偶尔会把上一轮的 call id 原样重放。
     * 这类调用尚未进入历史，不能使用 {@link #heal(List)} 的配对逻辑，
     * 因此在执行工具前单独做一次 ID 归一化。</p>
     */
    public static ONode normalizeIncomingToolCallIds(ONode toolCalls, List<ChatMessage> history) {
        if (toolCalls == null || !toolCalls.isArray()) {
            return toolCalls;
        }
        ONode normalized = ONode.ofJson(toolCalls.toJson()).asArray();
        Set<String> usedIds = knownCallIds(history);
        for (ONode call : normalized.getArray()) {
            if (call == null || !call.isObject()) {
                continue;
            }
            String rawId = nodeString(call, "id");
            String id = allocateCallId(rawId, usedIds);
            if (!Objects.equals(rawId, id)) {
                call.set("id", id);
            }
        }
        return normalized;
    }

    /**
     * 对消息列表执行全部修复，单次遍历（不创建临时列表）。
     * 直接操作 {@link ChatMessage} 对象，消除 ChatMessage ↔ Map 序列化往返。
     * 修复：
     * 1. 修复 tool_calls/tool 配对（丢弃孤立的 tool 和未配对的 tool_calls）
     * 2. 为推理模型补全 reasoning_content 字段
     * 3. 检测并修复重复的 tool_call_id（兜底，避免 API 400）
     * 4. 检测并修复 tool_calls 数组内的重复 id
     *
     * @param messages 原始消息列表
     * @return 整流结果（修复后的消息列表 + 是否发生修改）
     */
    public static HealResult heal(List<ChatMessage> messages) {
        if (messages == null || messages.isEmpty()) {
            return new HealResult(List.of(), false);
        }

        List<ChatMessage> out = new ArrayList<>(messages.size());
        boolean changed = false;

        // 跟踪所有已经分配给 assistant tool call 的 ID，范围覆盖整批消息。
        Set<String> seenToolCallIds = new HashSet<>();
        PendingBatch pending = null;

        for (ChatMessage msg : messages) {
            if (msg == null) {
                changed = true;
                continue;
            }
            String role = msg.getRole();

            // ======== 1. assistant tool_calls 整流，并建立当前批次的配对表 ========
            if ("assistant".equals(role) && msg.hasToolCalls()) {
                if (pending != null) {
                    changed |= stripUnmatchedCalls(out, pending);
                    pending = null;
                }

                NormalizedAssistant normalized = normalizeAssistant(msg, seenToolCallIds);
                changed |= normalized.changed();
                ChatMessage current = stampMissingReasoning(normalized.message());
                int assistantIndex = out.size();
                out.add(current);
                if (!normalized.pendingCalls().isEmpty()) {
                    pending = new PendingBatch(assistantIndex, normalized.pendingCalls());
                }
                continue;
            }

            // ======== 2. tool 结果必须按真实 ID 配对，不能只按数量配对 ========
            if ("tool".equals(role)) {
                if (pending == null) {
                    changed = true;
                    continue; // 丢弃孤立 tool
                }
                PendingCall matched = pending.match(msg.getToolCallId());
                if (matched == null) {
                    changed = true;
                    continue; // 丢弃无法归属当前 assistant 的 tool
                }
                matched.consumed = true;
                ChatMessage current = normalizeToolResult(msg, matched.normalizedId);
                if (current != msg) {
                    changed = true;
                }
                out.add(current);
                if (pending.allConsumed()) {
                    pending = null;
                }
                continue;
            }

            // 新的 user/system/assistant 到来时，前一批未完成的工具调用已经无法配对。
            if (pending != null) {
                changed |= stripUnmatchedCalls(out, pending);
                pending = null;
            }

            // ======== 3. 修复空 assistant，并补齐缺失 reasoning_content ========
            out.add(stampMissingReasoning(msg));
        }

        // ======== 末尾未配对的 tool_calls → 逐调用剥离 ========
        if (pending != null) {
            changed |= stripUnmatchedCalls(out, pending);
        }

        return new HealResult(out, changed);
    }

    /** 清洗一条 assistant 的 tool_calls，并为每个调用建立原始/归一化 ID 映射。 */
    private static NormalizedAssistant normalizeAssistant(
            ChatMessage message,
            Set<String> usedIds
    ) {
        List<ToolCallEntry> cleaned = new ArrayList<>();
        List<PendingCall> pending = new ArrayList<>();
        boolean changed = false;

        for (ToolCallEntry call : message.getToolCalls()) {
            if (call == null || call.name() == null || call.name().isBlank()) {
                changed = true;
                continue;
            }

            Object arguments = call.arguments();
            if (arguments instanceof String argStr) {
                try {
                    ONode.ofJson(argStr).toJson();
                } catch (Exception exception) {
                    arguments = "{}";
                    changed = true;
                }
            }

            String rawId = normalizeId(call.id());
            String normalizedId = allocateCallId(rawId, usedIds);
            if (!Objects.equals(call.id(), normalizedId)
                    || !Objects.equals(call.arguments(), arguments)) {
                changed = true;
            }

            ToolCallEntry normalized = new ToolCallEntry(
                    normalizedId,
                    call.name(),
                    arguments,
                    call.responseReasoning());
            cleaned.add(normalized);
            pending.add(new PendingCall(rawId, normalizedId, normalized));
        }

        ChatMessage effective = message;
        if (changed) {
            effective = message.copy();
            effective.setToolCalls(cleaned);
        }
        return new NormalizedAssistant(effective, pending, changed);
    }

    /** 将未配对调用从已写入的 assistant 消息中剥离。 */
    private static boolean stripUnmatchedCalls(List<ChatMessage> out, PendingBatch pending) {
        if (pending.allConsumed()) {
            return false;
        }
        List<ToolCallEntry> kept = pending.calls.stream()
                .filter(call -> call.consumed)
                .map(call -> call.entry)
                .toList();
        ChatMessage current = out.get(pending.assistantIndex).copy();
        current.setToolCalls(kept);
        out.set(pending.assistantIndex, stampMissingReasoning(current));
        return true;
    }

    /** 修复 tool 结果的 ID，并保留原有内容/时间戳/图片元数据。 */
    private static ChatMessage normalizeToolResult(ChatMessage message, String toolCallId) {
        ChatMessage current = message;
        if (!Objects.equals(message.getToolCallId(), toolCallId)) {
            current = message.copy();
            current.setToolCallId(toolCallId);
        }

        String toolContent = current.getContent();
        if (toolContent != null && toolContent.length() > 16_000) {
            int keepLen = Math.min(12_000, toolContent.length() / 2);
            String truncated = toolContent.substring(0, keepLen)
                    + "\n\n[truncated: 原文 " + toolContent.length() + " 字符，已截断至 " + keepLen + " 字符]";
            if (current == message) {
                current = message.copy();
            }
            current.setContent(truncated);
        }
        return current;
    }

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
                        if (id != null) ids.add(id);
                    }
                }
            } else if (message.isTool()) {
                String id = normalizeId(message.getToolCallId());
                if (id != null) ids.add(id);
            }
        }
        return ids;
    }

    /** 在已有 ID 集合中分配唯一 ID；保留原 ID 作为基础，便于日志排查。 */
    private static String allocateCallId(String rawId, Set<String> usedIds) {
        String base = rawId == null ? "healed_call" : rawId;
        String candidate = base;
        int suffix = 0;
        while (!usedIds.add(candidate)) {
            candidate = base + "_dedup_" + (suffix++);
        }
        return candidate;
    }

    private static String normalizeId(String id) {
        return id == null || id.isBlank() ? null : id;
    }

    private static String nodeString(ONode node, String key) {
        try {
            return node.get(key).getString();
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    private record NormalizedAssistant(
            ChatMessage message,
            List<PendingCall> pendingCalls,
            boolean changed
    ) {}

    private static final class PendingBatch {
        private final int assistantIndex;
        private final List<PendingCall> calls;

        private PendingBatch(int assistantIndex, List<PendingCall> calls) {
            this.assistantIndex = assistantIndex;
            this.calls = calls;
        }

        private PendingCall match(String toolCallId) {
            String rawId = normalizeId(toolCallId);
            if (rawId != null) {
                for (PendingCall call : calls) {
                    if (!call.consumed && Objects.equals(call.rawId, rawId)) {
                        return call;
                    }
                }
                for (PendingCall call : calls) {
                    if (!call.consumed && Objects.equals(call.normalizedId, rawId)) {
                        return call;
                    }
                }
            } else {
                // 缺少 ID 时仅能按当前 assistant 批次的顺序兜底配对。
                for (PendingCall call : calls) {
                    if (!call.consumed) {
                        return call;
                    }
                }
            }
            return null;
        }

        private boolean allConsumed() {
            return calls.stream().allMatch(call -> call.consumed);
        }
    }

    private static final class PendingCall {
        private final String rawId;
        private final String normalizedId;
        private final ToolCallEntry entry;
        private boolean consumed;

        private PendingCall(String rawId, String normalizedId, ToolCallEntry entry) {
            this.rawId = rawId;
            this.normalizedId = normalizedId;
            this.entry = entry;
        }
    }
}
