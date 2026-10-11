package site.sorghum.loopra.bin.agent.core;

import org.noear.snack4.ONode;
import site.sorghum.cutin.core.context.Usage;
import site.sorghum.loopra.bin.agent.model.StreamResult;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * cutin 模型流的一次完整快照：正文、推理、工具调用、思考块、用量与错误。
 * <p>由 {@link CutinStreamSupport#collect} 从增量流聚合而来，供模型步骤
 * 与 HITL 暂存/重放路径共用。</p>
 */
record CutinStreamSnapshot(
    String content,
    String reasoningContent,
    List<site.sorghum.cutin.core.tool.ToolCall> cutinToolCalls,
    List<String> thinkingBlocks,
    Usage usage,
    String errorMessage,
    String responseReasoning
) {
    boolean error() {
        return errorMessage != null;
    }

    ONode toolCalls() {
        ONode calls = ONode.ofJson("[]").asArray();
        for (site.sorghum.cutin.core.tool.ToolCall call : cutinToolCalls) {
            ONode item = calls.addNew().asObject();
            item.set("id", call.id());
            item.set("type", "function");
            ONode function = item.getOrNew("function");
            function.set("name", call.toolId());
            function.set("arguments", ONode.ofBean(call.arguments()).toJson());
        }
        return calls;
    }

    CutinStreamSnapshot withToolCalls(ONode scavengedToolCalls) {
        List<site.sorghum.cutin.core.tool.ToolCall> calls = new ArrayList<>();
        if (scavengedToolCalls != null && scavengedToolCalls.isArray()) {
            for (ONode node : scavengedToolCalls.getArray()) {
                String id = node.get("id").getString();
                ONode function = node.get("function");
                String name = function.get("name").getString();
                ONode arguments = function.get("arguments");
                Map<String, Object> args = new HashMap<>();
                if (arguments.isString()) {
                    try {
                        Object bean = ONode.ofJson(arguments.getString()).toBean(Map.class);
                        if (bean instanceof Map<?, ?> map) {
                            for (Map.Entry<?, ?> entry : map.entrySet()) {
                                args.put(String.valueOf(entry.getKey()), entry.getValue());
                            }
                        }
                    } catch (RuntimeException ignored) {
                         // 格式错误的 JSON 保留空参数
                    }
                } else if (arguments.isObject()) {
                    Object bean = arguments.toBean(Map.class);
                    if (bean instanceof Map<?, ?> map) {
                        for (Map.Entry<?, ?> entry : map.entrySet()) {
                            args.put(String.valueOf(entry.getKey()), entry.getValue());
                        }
                    }
                }
                calls.add(new site.sorghum.cutin.core.tool.ToolCall(id, name, args, id));
            }
        }
        return new CutinStreamSnapshot(content, reasoningContent, calls, thinkingBlocks, usage, errorMessage, responseReasoning);
    }

    StreamResult toStreamResult() {
        return new StreamResult(content, reasoningContent, toolCalls(), error(), errorMessage);
    }
}
