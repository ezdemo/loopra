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
import site.sorghum.loopra.bin.agent.context.ToolCallMessageHealer;

import java.util.ArrayList;
import java.util.List;

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

        ToolCallMessageHealer.HealResult<Message> result =
            ToolCallMessageHealer.heal(messages, CUTIN_MESSAGE_ADAPTER);
        List<Message> healed = new ArrayList<>(result.messages().size());
        boolean changed = result.changed();
        for (Message message : result.messages()) {
            Message current = healEmptyAssistant(message);
            changed |= current != message;
            healed.add(current);
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

    private static final ToolCallMessageHealer.Adapter<Message, ToolCall>
        CUTIN_MESSAGE_ADAPTER = new ToolCallMessageHealer.Adapter<>() {
        @Override
        public String role(Message message) {
            return message.role();
        }

        @Override
        public String content(Message message) {
            return message.content();
        }

        @Override
        public String toolCallId(Message message) {
            return message.toolCallId();
        }

        @Override
        public List<ToolCall> toolCalls(Message message) {
            return message.toolCalls();
        }

        @Override
        public boolean isUsableToolCall(ToolCall call) {
            return call != null && call.toolId() != null && !call.toolId().isBlank();
        }

        @Override
        public String callId(ToolCall call) {
            return call.id();
        }

        @Override
        public ToolCall withToolCallId(ToolCall call, String id) {
            return new ToolCall(id, call.toolId(), call.arguments(), id);
        }

        @Override
        public Message withToolCalls(Message message, List<ToolCall> calls) {
            return new Message(
                message.role(),
                message.content(),
                message.toolCallId(),
                calls,
                message.metadata()
            );
        }

        @Override
        public Message withMessageToolCallId(Message message, String id) {
            return new Message(
                message.role(),
                message.content(),
                id,
                message.toolCalls(),
                message.metadata()
            );
        }

        @Override
        public Message withContent(Message message, String content) {
            return new Message(
                message.role(),
                content,
                message.toolCallId(),
                message.toolCalls(),
                message.metadata()
            );
        }
    };

    /** 兼容部分 provider 拒绝 content=null 的空 assistant 消息。 */
    private static Message healEmptyAssistant(Message message) {
        if (!"assistant".equals(message.role())
            || message.content() != null
            || message.hasToolCalls()) {
            return message;
        }
        return CUTIN_MESSAGE_ADAPTER.withContent(message, "");
    }
}
