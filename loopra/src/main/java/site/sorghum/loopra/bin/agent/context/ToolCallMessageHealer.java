package site.sorghum.loopra.bin.agent.context;

import org.noear.snack4.ONode;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/**
 * 协议无关的工具调用消息整流器。
 *
 * <p>Loopra 内部的 {@code ChatMessage} 与 cutin 的不可变 {@code Message}
 * 使用不同的数据模型，但它们都需要相同的工具调用约束：assistant 的调用 ID
 * 在整批消息中唯一，后续 tool 结果必须和对应调用配对。这里集中维护这套算法，
 * 具体消息模型通过 {@link Adapter} 负责复制/重建。</p>
 */
public final class ToolCallMessageHealer {

    private ToolCallMessageHealer() {
    }

    /** 不同消息模型的最小适配接口。 */
    public interface Adapter<M, C> {
        String role(M message);

        String content(M message);

        String toolCallId(M message);

        List<C> toolCalls(M message);

        boolean isUsableToolCall(C call);

        String callId(C call);

        C withToolCallId(C call, String id);

        M withToolCalls(M message, List<C> calls);

        M withMessageToolCallId(M message, String id);

        M withContent(M message, String content);

        /**
         * 允许具体协议在重建调用时顺手修复参数等字段。
         * 默认只负责 ID 归一化。
         */
        default NormalizedCall<C> normalizeCall(C call, String normalizedId) {
            if (Objects.equals(callId(call), normalizedId)) {
                return new NormalizedCall<>(call, false);
            }
            return new NormalizedCall<>(withToolCallId(call, normalizedId), true);
        }

        /** 允许具体协议在保留 tool 结果时做额外裁剪。 */
        default M normalizeToolResult(M message) {
            return message;
        }
    }

    /** 一次调用归一化后的值及是否发生了字段修改。 */
    public record NormalizedCall<C>(C call, boolean changed) {
    }

    /** 通用整流结果。 */
    public record HealResult<M>(List<M> messages, boolean changed) {
    }

    /**
     * 清洗一批消息中的 assistant/tool 调用关系。
     *
     * <ul>
     *   <li>assistant 工具调用 ID 在整批消息范围内唯一；</li>
     *   <li>tool 结果优先按原始 ID、再按归一化 ID 配对；</li>
     *   <li>丢弃孤立或无法归属当前 assistant 批次的 tool 结果；</li>
     *   <li>剥离没有结果的 assistant 工具调用，但保留已经配对的调用。</li>
     * </ul>
     */
    public static <M, C> HealResult<M> heal(
            List<M> messages,
            Adapter<M, C> adapter
    ) {
        Objects.requireNonNull(adapter, "adapter must not be null");
        if (messages == null || messages.isEmpty()) {
            return new HealResult<>(List.of(), false);
        }

        List<M> out = new ArrayList<>(messages.size());
        Set<String> usedCallIds = new HashSet<>();
        PendingBatch<C> pending = null;
        boolean changed = false;

        for (M message : messages) {
            if (message == null) {
                changed = true;
                continue;
            }

            List<C> calls = adapter.toolCalls(message);
            if ("assistant".equals(adapter.role(message))
                    && calls != null && !calls.isEmpty()) {
                if (pending != null) {
                    changed |= stripUnmatchedCalls(out, pending, adapter);
                    pending = null;
                }

                NormalizedAssistant<M, C> normalized = normalizeAssistant(
                        message, calls, adapter, usedCallIds);
                changed |= normalized.changed();
                int assistantIndex = out.size();
                out.add(normalized.message());
                if (!normalized.pendingCalls().isEmpty()) {
                    pending = new PendingBatch<>(assistantIndex, normalized.pendingCalls());
                }
                continue;
            }

            if ("tool".equals(adapter.role(message))) {
                if (pending == null) {
                    changed = true;
                    continue;
                }
                PendingCall<C> matched = pending.match(adapter.toolCallId(message));
                if (matched == null) {
                    changed = true;
                    continue;
                }
                matched.consumed = true;

                M current = message;
                if (!Objects.equals(adapter.toolCallId(message), matched.normalizedId)) {
                    current = adapter.withMessageToolCallId(message, matched.normalizedId);
                    changed = true;
                }
                M normalizedResult = adapter.normalizeToolResult(current);
                if (normalizedResult != current) {
                    changed = true;
                }
                out.add(normalizedResult);
                if (pending.allConsumed()) {
                    pending = null;
                }
                continue;
            }

            if (pending != null) {
                changed |= stripUnmatchedCalls(out, pending, adapter);
                pending = null;
            }
            out.add(message);
        }

        if (pending != null) {
            changed |= stripUnmatchedCalls(out, pending, adapter);
        }
        return new HealResult<>(out, changed);
    }

    /**
     * 为刚返回、尚未写入历史的工具调用分配唯一 ID。
     * 该入口与消息批次整流共用同一个分配规则。
     */
    public static ONode normalizeIncomingToolCallIds(
            ONode toolCalls,
            Set<String> existingIds
    ) {
        if (toolCalls == null || !toolCalls.isArray()) {
            return toolCalls;
        }
        ONode normalized = ONode.ofJson(toolCalls.toJson()).asArray();
        Set<String> usedIds = existingIds == null
                ? new HashSet<>()
                : new HashSet<>(existingIds);
        for (ONode call : normalized.getArray()) {
            if (call == null || !call.isObject()) {
                continue;
            }
            String rawId = normalizeId(nodeString(call, "id"));
            String id = allocateCallId(rawId, usedIds);
            if (!Objects.equals(rawId, id)) {
                call.set("id", id);
            }
        }
        return normalized;
    }

    private static <M, C> NormalizedAssistant<M, C> normalizeAssistant(
            M message,
            List<C> calls,
            Adapter<M, C> adapter,
            Set<String> usedCallIds
    ) {
        List<C> cleaned = new ArrayList<>();
        List<PendingCall<C>> pending = new ArrayList<>();
        boolean changed = false;

        for (C call : calls) {
            if (!adapter.isUsableToolCall(call)) {
                changed = true;
                continue;
            }

            String rawId = normalizeId(adapter.callId(call));
            String normalizedId = allocateCallId(rawId, usedCallIds);
            NormalizedCall<C> normalized = adapter.normalizeCall(call, normalizedId);
            changed |= normalized.changed();
            cleaned.add(normalized.call());
            pending.add(new PendingCall<>(rawId, normalizedId, normalized.call()));
        }

        M effective = changed ? adapter.withToolCalls(message, cleaned) : message;
        return new NormalizedAssistant<>(effective, pending, changed);
    }

    private static <M, C> boolean stripUnmatchedCalls(
            List<M> out,
            PendingBatch<C> pending,
            Adapter<M, C> adapter
    ) {
        if (pending.allConsumed()) {
            return false;
        }
        List<C> kept = pending.calls.stream()
                .filter(call -> call.consumed)
                .map(call -> call.call)
                .toList();
        M old = out.get(pending.assistantIndex);
        out.set(pending.assistantIndex, adapter.withToolCalls(old, kept));
        return true;
    }

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

    private record NormalizedAssistant<M, C>(
            M message,
            List<PendingCall<C>> pendingCalls,
            boolean changed
    ) {
    }

    private static final class PendingBatch<C> {
        private final int assistantIndex;
        private final List<PendingCall<C>> calls;

        private PendingBatch(int assistantIndex, List<PendingCall<C>> calls) {
            this.assistantIndex = assistantIndex;
            this.calls = calls;
        }

        private PendingCall<C> match(String toolCallId) {
            String rawId = normalizeId(toolCallId);
            if (rawId != null) {
                for (PendingCall<C> call : calls) {
                    if (!call.consumed && Objects.equals(call.rawId, rawId)) {
                        return call;
                    }
                }
                for (PendingCall<C> call : calls) {
                    if (!call.consumed && Objects.equals(call.normalizedId, rawId)) {
                        return call;
                    }
                }
            } else {
                for (PendingCall<C> call : calls) {
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

    private static final class PendingCall<C> {
        private final String rawId;
        private final String normalizedId;
        private final C call;
        private boolean consumed;

        private PendingCall(String rawId, String normalizedId, C call) {
            this.rawId = rawId;
            this.normalizedId = normalizedId;
            this.call = call;
        }
    }
}
