package site.sorghum.loopra.bin.agent.core;

import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.Feature;
import org.noear.snack4.ONode;
import org.noear.snack4.Options;
import org.noear.snack4.json.JsonReader;
import org.noear.snack4.json.util.FormatUtil;
import org.noear.solon.ai.chat.tool.ToolCall;
import site.sorghum.cutin.core.context.Message;
import site.sorghum.cutin.core.context.Usage;
import site.sorghum.cutin.core.model.ModelResponse;
import site.sorghum.cutin.core.model.StreamChunk;
import site.sorghum.loopra.bin.agent.model.ToolCallEntry;
import site.sorghum.loopra.bin.agent.resilient.Scavenger;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

/**
 * cutin 流式响应与 Loopra 消息模型之间的桥接工具：
 * 聚合增量块为 {@link CutinStreamSnapshot}、在 ONode 与
 * cutin/solon 工具调用模型之间互转、以及从正文回收工具调用。
 */
@Slf4j
final class CutinStreamSupport {

    private CutinStreamSupport() {
    }

    /** 聚合整条增量流为一次快照（含 response_reasoning 摘要展开与终止错误提取）。 */
    static CutinStreamSnapshot collect(Stream<StreamChunk> chunks) {
        StringBuilder content = new StringBuilder();
        StringBuilder reasoning = new StringBuilder();
        List<site.sorghum.cutin.core.tool.ToolCall> toolCalls = new ArrayList<>();
        List<String> thinkingBlocks = new ArrayList<>();
        Usage[] usage = {Usage.ZERO};
        String[] error = {null};
        String[] responseReasoning = {null};
        chunks.forEach(chunk -> {
            if (chunk.content() != null) {
                content.append(chunk.content());
            }
            if (chunk.reasoning() != null) {
                reasoning.append(chunk.reasoning());
            }
            toolCalls.addAll(chunk.toolCalls());
            thinkingBlocks.addAll(chunk.thinkingBlocks());
            usage[0] = usage[0].add(chunk.usage());
            Object terminalError = chunk.metadata().get("error");
            if (terminalError != null && chunk.terminal()) {
                error[0] = String.valueOf(terminalError);
            }
            Object reasoningMeta = chunk.metadata().get("response_reasoning");
            if (reasoningMeta != null) {
                responseReasoning[0] = String.valueOf(reasoningMeta);
            }
            Object reasoningContent = chunk.metadata().get("reasoning_content");
            if (reasoningContent != null && reasoning.length() == 0) {
                reasoning.append(String.valueOf(reasoningContent));
            }
        });
        String reasoningStr = reasoning.length() == 0 ? null : reasoning.toString();
        if (responseReasoning[0] != null) {
            try {
                ONode item = ONode.ofJson(responseReasoning[0]);
                ONode summary = item.get("summary");
                if (summary != null && summary.isArray()) {
                    StringBuilder sb = new StringBuilder();
                    for (ONode part : summary.getArray()) {
                        String text = part.get("text").getString();
                        if (text != null) sb.append(text);
                    }
                    if (sb.length() > 0) {
                        reasoningStr = sb.toString();
                    }
                }
            } catch (RuntimeException ignored) {
                // 推理条目解析失败时跳过
            }
        }
        return new CutinStreamSnapshot(
            content.length() == 0 ? null : content.toString(),
            reasoningStr,
            toolCalls,
            thinkingBlocks,
            usage[0],
            error[0],
            responseReasoning[0]
        );
    }

    /** 从模型响应构造快照（HITL 恢复路径使用）。 */
    static CutinStreamSnapshot cutinSnapshotFromResponse(ModelResponse response) {
        Object thinking = response.message().metadata("thinking_blocks");
        return new CutinStreamSnapshot(
                response.message().content(),
                metadataString(response.message(), "reasoning_content"),
                response.message().toolCalls(),
                thinking instanceof List<?> list ? list.stream().map(String::valueOf).toList() : List.of(),
                response.usage() == null ? Usage.ZERO : response.usage(),
                null,
                metadataString(response.message(), "response_reasoning"));
    }

    /** 将 cutin 消息上的工具调用转成 ONode 数组（供 legacy 工具管线使用）。 */
    static ONode toolCallsFromCutinMessage(Message message) {
        ONode calls = ONode.ofJson("[]").asArray();
        for (site.sorghum.cutin.core.tool.ToolCall call : message.toolCalls()) {
            ONode item = calls.addNew().asObject();
            item.set("id", call.id());
            item.set("type", "function");
            ONode function = item.getOrNew("function");
            function.set("name", call.toolId());
            function.set("arguments", ONode.ofBean(call.arguments()).toJson());
        }
        return calls;
    }

    static String metadataString(Message message, String key) {
        Object value = message.metadata(key);
        return value == null ? null : String.valueOf(value);
    }

    /**
     * 从 ONode 解析工具调用列表（不含暂存副作用）。
     */
    static List<ToolCallEntry> parseToolCallsFromONode(ONode toolCalls) {
        return ToolCallEntry.fromToolCalls(toolCalls);
    }

    /**
     * 从模型正文/推理中回收工具调用（Scavenger）：模型把工具调用写进
     * 正文而非 toolCalls 字段时兜底，返回与正常路径一致的 ONode 数组。
     */
    static ONode scavengeToolCalls(ONode toolCalls, String reasoningContent, String content) {
        boolean hasToolCalls = toolCalls != null && toolCalls.isArray() && !toolCalls.getArray().isEmpty();
        if (hasToolCalls) return toolCalls;
        if (reasoningContent == null && content == null) return toolCalls;

        List<Scavenger.ToolCall> scavenged = Scavenger.scavenge(reasoningContent, content, new ArrayList<>());
        if (scavenged.isEmpty()) return toolCalls;

        ONode fakeTcArray = ONode.ofJson("[]").asArray();
        for (Scavenger.ToolCall tc : scavenged) {
            ONode tcn = fakeTcArray.addNew();
            String idSuffix = tc.id() != null ? ""
                    : "_" + Integer.toHexString(tc.arguments().hashCode())
                    + "_" + System.nanoTime();
            tcn.set("id", tc.id() != null ? tc.id() : "scavenged_" + tc.name() + idSuffix);
            tcn.set("type", "function");
            ONode fn = tcn.getOrNew("function");
            fn.set("name", tc.name());
            fn.set("arguments", tc.arguments());
        }
        return fakeTcArray;
    }

    /** 把单个 tool_call ONode 解析为 solon {@link ToolCall}（含嵌套 JSON 修复）。 */
    static ToolCall getToolCall(ONode n1) {
        String callId = n1.get("id").getString();

        String index = n1.get("index").getString();

        ONode n1f = n1.get("function");
        String name = n1f.get("name").getString(); //可能是空的
        ONode n1fArgs = n1f.get("arguments");
        String argStr = n1fArgs.getString();

        if (n1fArgs.isString()) {
            //有可能是 json string（还可能只是流的中间消息）
            if (FormatUtil.hasNestedJsonBlock(argStr)) {
                JsonReader reader = new JsonReader(argStr, Options.of(Feature.Read_AutoRepair));
                n1fArgs = reader.readLast();

                if (n1fArgs == null) {
                    log.warn("Parse tool arguments failed: {}", argStr);
                }
            }
        }

        Map<String, Object> argMap = new HashMap<>();
        if (n1fArgs != null) {
            if (n1fArgs.isObject()) {
                argMap = n1fArgs.toBean(Map.class);
            }
        }

        return new ToolCall(index, callId, name, argStr, argMap);
    }
}
