package site.sorghum.loopra.integration.cutin.plugin.policy;

import site.sorghum.cutin.core.context.Message;
import site.sorghum.cutin.core.loop.InterceptContext;
import site.sorghum.cutin.core.loop.InterceptDecision;
import site.sorghum.cutin.core.loop.InterceptPoint;
import site.sorghum.cutin.core.model.ModelCallRequest;
import site.sorghum.cutin.core.plugin.AgentPlugin;
import site.sorghum.cutin.core.plugin.LoopPlugin;
import site.sorghum.cutin.core.plugin.LoopRegistrar;
import site.sorghum.cutin.core.tool.ToolCall;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;

/** 在模型调用前修复不满足兼容 API 约束的消息。 */
@AgentPlugin(id = "loopra-message-healing", remark = "修复不符合模型接口约束的历史消息，提升兼容性。")
public final class LoopraMessageHealingPlugin implements LoopPlugin {

    @Override
    public String id() {
        return "loopra-message-healing";
    }

    @Override
    public void register(LoopRegistrar registrar) {
        registrar.registerInterceptor(InterceptPoint.BEFORE_MODEL, 100, this::healRequest);
    }

    private InterceptDecision healRequest(InterceptContext context) {
        if (!(context.payload() instanceof ModelCallRequest request)) {
            return InterceptDecision.pass();
        }

        List<Message> messages = request.messages();
        if (messages == null || messages.isEmpty()) {
            return InterceptDecision.pass();
        }

        List<Message> healed = new ArrayList<>(messages.size());
        Set<String> usedCallIds = new HashSet<>();
        PendingBatch pending = null;
        boolean changed = false;

        for (Message message : messages) {
            if (message == null) {
                changed = true;
                continue;
            }

            if ("assistant".equals(message.role()) && message.hasToolCalls()) {
                if (pending != null) {
                    changed |= stripUnmatchedCalls(healed, pending);
                    pending = null;
                }

                NormalizedAssistant normalized = normalizeAssistant(message, usedCallIds);
                Message current = healEmptyAssistant(normalized.message());
                changed |= normalized.changed() || current != normalized.message();
                int assistantIndex = healed.size();
                healed.add(current);
                if (!normalized.pendingCalls().isEmpty()) {
                    pending = new PendingBatch(assistantIndex, normalized.pendingCalls());
                }
                continue;
            }

            if ("tool".equals(message.role())) {
                if (pending == null) {
                    changed = true;
                    continue;
                }
                PendingCall matched = pending.match(message.toolCallId());
                if (matched == null) {
                    changed = true;
                    continue;
                }
                matched.consumed = true;
                Message current = normalizeToolResult(message, matched.normalizedId);
                changed |= current != message;
                healed.add(current);
                if (pending.allConsumed()) {
                    pending = null;
                }
                continue;
            }

            if (pending != null) {
                changed |= stripUnmatchedCalls(healed, pending);
                pending = null;
            }

            Message current = healEmptyAssistant(message);
            changed |= current != message;
            healed.add(current);
        }

        if (pending != null) {
            changed |= stripUnmatchedCalls(healed, pending);
        }

        if (!changed) {
            return InterceptDecision.pass();
        }
        return InterceptDecision.replace(new ModelCallRequest(
            request.modelId(),
            healed,
            request.tools(),
            request.options()
        ));
    }

    /** 清洗 assistant 工具调用，并建立原始 ID 到归一化 ID 的配对映射。 */
    private static NormalizedAssistant normalizeAssistant(
        Message message,
        Set<String> usedCallIds
    ) {
        List<ToolCall> cleaned = new ArrayList<>();
        List<PendingCall> pending = new ArrayList<>();
        boolean changed = false;

        for (ToolCall call : message.toolCalls()) {
            if (call == null || call.toolId() == null || call.toolId().isBlank()) {
                changed = true;
                continue;
            }

            String rawId = normalizeId(call.id());
            String normalizedId = allocateCallId(rawId, usedCallIds);
            ToolCall normalized = call;
            if (!Objects.equals(call.id(), normalizedId)) {
                normalized = new ToolCall(
                    normalizedId,
                    call.toolId(),
                    call.arguments(),
                    normalizedId
                );
                changed = true;
            }
            cleaned.add(normalized);
            pending.add(new PendingCall(rawId, normalizedId, normalized));
        }

        Message effective = message;
        if (changed) {
            effective = new Message(
                message.role(),
                message.content(),
                message.toolCallId(),
                cleaned,
                message.metadata()
            );
        }
        return new NormalizedAssistant(effective, pending, changed);
    }

    /** 将未配对的工具调用从已经写入的 assistant 消息中剥离。 */
    private static boolean stripUnmatchedCalls(List<Message> messages, PendingBatch pending) {
        if (pending.allConsumed()) {
            return false;
        }
        List<ToolCall> kept = pending.calls.stream()
            .filter(call -> call.consumed)
            .map(call -> call.toolCall)
            .toList();
        Message old = messages.get(pending.assistantIndex);
        String content = kept.isEmpty() && old.content() == null ? "" : old.content();
        messages.set(pending.assistantIndex, new Message(
            old.role(),
            content,
            old.toolCallId(),
            kept,
            old.metadata()
        ));
        return true;
    }

    /** 修复 tool 结果的 ID，确保与对应 assistant call 使用相同的 ID。 */
    private static Message normalizeToolResult(Message message, String toolCallId) {
        if (Objects.equals(message.toolCallId(), toolCallId)) {
            return message;
        }
        return new Message(
            message.role(),
            message.content(),
            toolCallId,
            message.toolCalls(),
            message.metadata()
        );
    }

    /** 兼容部分 provider 拒绝 content=null 的空 assistant 消息。 */
    private static Message healEmptyAssistant(Message message) {
        if (!"assistant".equals(message.role())
            || message.content() != null
            || message.hasToolCalls()) {
            return message;
        }
        return new Message(
            message.role(),
            "",
            message.toolCallId(),
            message.toolCalls(),
            message.metadata()
        );
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

    private record NormalizedAssistant(
        Message message,
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
                // 缺少 ID 时只能按当前 assistant 批次的顺序兜底配对。
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
        private final ToolCall toolCall;
        private boolean consumed;

        private PendingCall(String rawId, String normalizedId, ToolCall toolCall) {
            this.rawId = rawId;
            this.normalizedId = normalizedId;
            this.toolCall = toolCall;
        }
    }
}
