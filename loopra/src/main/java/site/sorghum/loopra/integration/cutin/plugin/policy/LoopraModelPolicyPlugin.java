package site.sorghum.loopra.integration.cutin.plugin.policy;

import org.noear.solon.ai.chat.tool.FunctionTool;
import site.sorghum.cutin.core.context.LoopContext;
import site.sorghum.cutin.core.context.Message;
import site.sorghum.cutin.core.loop.InterceptContext;
import site.sorghum.cutin.core.loop.InterceptDecision;
import site.sorghum.cutin.core.loop.InterceptPoint;
import site.sorghum.cutin.core.model.ModelCallRequest;
import site.sorghum.cutin.core.model.ModelResponse;
import site.sorghum.cutin.core.model.StreamChunk;
import site.sorghum.cutin.core.plugin.AgentPlugin;
import site.sorghum.cutin.core.plugin.LoopPlugin;
import site.sorghum.cutin.core.plugin.LoopRegistrar;
import site.sorghum.cutin.core.tool.ToolDefinition;
import site.sorghum.loopra.bin.agent.resilient.ReasonBreaker;
import site.sorghum.loopra.bin.tool.ToolMetadata;
import site.sorghum.loopra.integration.cutin.plugin.preflight.LoopraPreflight;
import site.sorghum.loopra.tool.LogLevel;

import java.util.List;
import java.util.Map;

/**
  * Loopra 面向模型的规则：计划模式工具过滤、实时流式输出、
  * 推理循环检测，以及模型响应后的人工审批挂起。
 */
@AgentPlugin(id = "loopra-model-policy", remark = "根据模型策略调整请求参数与调用行为。")
public final class LoopraModelPolicyPlugin implements LoopPlugin {

    private final LoopraPolicyHost host;

    public LoopraModelPolicyPlugin(LoopraPolicyHost host) {
        this.host = host;
    }

    @Override
    public String id() {
        return "loopra-model-policy";
    }

    @Override
    public void register(LoopRegistrar registrar) {
        registrar.registerInterceptor(InterceptPoint.BEFORE_MODEL, -100, this::prepareModelRequest);
        registrar.registerInterceptor(InterceptPoint.ON_MODEL_STREAM, 0, this::onModelStream);
        registrar.registerInterceptor(InterceptPoint.AFTER_MODEL, 0, this::onAfterModel);
    }

    private InterceptDecision prepareModelRequest(InterceptContext context) {
        ModelCallRequest request = payloadRequest(context);
        List<Message> messages = context.context().messages();
        if (!hasUsableInput(messages)) {
            // 兜底保护：上下文没有任何可发送给模型的输入时（空回合、
            // 清洗后内容被完全移除等），跳转到 output 节点优雅结束本轮，
            // 而不是携带空消息调用模型网关触发上游 400（如 input must be non-empty）。
            context.context().putVariable("loopraExitReason", "empty_input");
            context.context().putVariable(LoopraPreflight.RESULT_VARIABLE,
                "没有可供模型处理的消息内容，已跳过模型调用。请用文字描述你的需求后再试。");
            return InterceptDecision.gotoNode(LoopraPreflight.OUTPUT_NODE);
        }
        List<ToolDefinition> tools = context.context().tools().definitions().stream()
            .filter(tool -> !host.isPlanMode() || isReadOnly(tool.id()))
            .toList();
        ModelCallRequest effective = new ModelCallRequest(
            request.modelId(),
            messages,
            tools,
            request.options()
        );
        return InterceptDecision.modified(context.context(), effective);
    }

    private static boolean hasUsableInput(List<Message> messages) {
        return messages.stream().anyMatch(message ->
            !"system".equals(message.role())
                && ((message.content() != null && !message.content().isEmpty())
                    || message.hasToolCalls()
                    || message.metadata("images") instanceof List<?> images && !images.isEmpty()));
    }

    private ModelCallRequest payloadRequest(InterceptContext context) {
        if (context.payload() instanceof ModelCallRequest request) {
            return request;
        }
        return new ModelCallRequest("", List.of(), List.of(), Map.of());
    }

    private InterceptDecision onModelStream(InterceptContext context) {
        if (!(context.payload() instanceof StreamChunk chunk)) {
            return InterceptDecision.pass();
        }
        emitStream(chunk);
        if (chunk.reasoning() == null || chunk.reasoning().isEmpty()) {
            return InterceptDecision.pass();
        }
        return reasonBreak(chunk, context.context());
    }

    private void emitStream(StreamChunk chunk) {
        try {
            if (chunk.content() != null && !chunk.content().isEmpty()) {
                host.getOutput().onContentDelta(chunk.content());
            }
            if (chunk.reasoning() != null && !chunk.reasoning().isEmpty()) {
                host.getOutput().onReasoningDelta(chunk.reasoning());
            }
            if (chunk.terminal()) {
                host.getOutput().onContentComplete();
            }
        } catch (Exception ignored) {
            // SSE 断开是预期行为，与旧循环一致
        }
    }

    private InterceptDecision reasonBreak(StreamChunk chunk, LoopContext context) {
        String prior = String.valueOf(context.variables().getOrDefault("loopraReasoning", ""));
        String reasoning = prior + chunk.reasoning();
        int checkLen = intVariable(context, "loopraReasonCheckLen");
        int consecutiveHits = intVariable(context, "loopraReasonHits");
        context.putVariable("loopraReasoning", reasoning);

        if (reasoning.length() - checkLen < 1000) {
            return InterceptDecision.modified(context);
        }
        context.putVariable("loopraReasonCheckLen", reasoning.length());
        ReasonBreaker.LoopResult result = host.reasonBreaker().analyze(reasoning);
        if (!result.looping) {
            context.putVariable("loopraReasonHits", 0);
            return InterceptDecision.modified(context);
        }

        consecutiveHits++;
        context.putVariable("loopraReasonHits", consecutiveHits);
        if (consecutiveHits == 1) {
            try {
                host.getOutput().onLog(LogLevel.WARN,
                        "[ReasonBreaker] 疑似思考循环（软警告）—— " + result.toWarning());
            } catch (Exception ignored) {
                // SSE 断开时忽略
            }
            return InterceptDecision.modified(context);
        }

        host.reasonBreaker().recordTrigger();
        try {
            host.getModelProvider().abortStream();
        } catch (Exception ignored) {
            // 部分测试 Provider 不实现中止语义
        }
        // retry 会重新走一轮模型流：先通知前端作废本轮已流出的思考/正文，
        // 否则两轮输出会叠加在同一条消息里，视觉上表现为"同一个思考重复渲染"。
        try {
            host.getOutput().sendEvent("stream_reset", "{}");
        } catch (Exception ignored) {
            // SSE 断开时忽略
        }
        host.injectReasonBreakReminder();
        return InterceptDecision.retry("[ReasonBreaker] 连续两次检测到思考循环，重试本轮推理。" + result.toWarning());
    }

    private InterceptDecision onAfterModel(InterceptContext context) {
        if (!(context.payload() instanceof ModelResponse response)) {
            return InterceptDecision.pass();
        }
        String prompt = host.interceptHITLFromCutin(response);
        if (prompt == null) {
            return InterceptDecision.pass();
        }
        context.context().putVariable("loopraPendingModelResponse", response);
        return InterceptDecision.suspend(prompt);
    }

    private boolean isReadOnly(String toolId) {
        // 优先用 cutin 的 ToolDefinition 元数据，兼容插件禁用后 legacy 为空的场景
        try {
            var def = host.getCutinTools() != null ? host.getCutinTools().find(toolId).orElse(null) : null;
            if (def != null) return def.definition().metadata().readOnly();
        } catch (Exception ignored) {
            // cutin 元数据查询失败时回退到 legacy 判断
        }
        FunctionTool tool = host.getToolRegistry().get(toolId);
        return tool != null && ToolMetadata.isReadOnly(tool);
    }

    private static int intVariable(LoopContext context, String key) {
        Object value = context.variables().get(key);
        return value instanceof Number number ? number.intValue() : 0;
    }
}
