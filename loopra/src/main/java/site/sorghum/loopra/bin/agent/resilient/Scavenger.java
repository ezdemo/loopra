package site.sorghum.loopra.bin.agent.resilient;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 工具调用回收 —— 从 reasoning_content 中扫描丢失的工具调用。
 * <p>
 * DeepSeek-R1/V4 有时把工具调用写在 reasoning_content 中而忘了写入 tool_calls 字段。
 * 回收器扫描两种格式：
 * 1. DSML 标记：{@code <invoke name="xxx">...}
 * 2. 裸 JSON：{@code {"name": "xxx", "arguments": {...}}}
 * </p>
 *
 * @author Sorghum
 */
public class Scavenger {

    /**
     * DSML 标记模式：<invoke name="xxx">...参数...</invoke>
     */
    private static final Pattern DSML_INVOKE = Pattern.compile(
            "<invoke\\s+name=\"([^\"]+)\">([\\s\\S]*?)</invoke>", Pattern.CASE_INSENSITIVE);

    /**
     * 裸 JSON 工具调用模式：匹配 {name, arguments} 等格式。要求存在 arguments/tool_args 字段，减少误报。
     */
    private static final Pattern JSON_CALL = Pattern.compile(
            "\\{\\s*\"(?:name|tool_name|function)\"\\s*:\\s*\"(\\w+)\"\\s*,\\s*\"(?:arguments|tool_args)\"");

    /**
     * 从 reasoning_content 和 content 中回收丢失的工具调用。
     * DeepSeek R1/V4 有时将工具调用写在 reasoning_content 中却忘了写入 tool_calls 字段。
     * 回收器扫描两种格式：DSML 标记 和 裸 JSON。
     *
     * @param reasoningContent 模型的思考内容
     * @param content          模型回复内容
     * @param existingCalls    已存在的工具调用（去重用）
     * @return 新发现的工具调用列表
     */
    public static List<ToolCall> scavenge(String reasoningContent, String content,
                                          List<ToolCall> existingCalls) {
        Set<String> seenSignatures = new HashSet<>();
        for (ToolCall tc : existingCalls) {
            seenSignatures.add(tc.name + "|" + tc.arguments);
        }

        String combined = (reasoningContent != null ? reasoningContent : "")
                + "\n" + (content != null ? content : "");
        List<ToolCall> found = new ArrayList<>();

        // 1. DSML 格式
        Matcher dm = DSML_INVOKE.matcher(combined);
        while (dm.find()) {
            String name = dm.group(1);
            String body = dm.group(2).trim();
            String args = extractDsmlArgs(body);
            String sig = name + "|" + args;
            if (!seenSignatures.contains(sig)) {
                ToolCall tc = new ToolCall(null, name, args);
                found.add(tc);
                seenSignatures.add(sig);
            }
        }

        // 2. 裸 JSON 格式（简化：只找最外层 {name, arguments}）
        String[] lines = combined.split("\n");
        for (int i = 0; i < lines.length; i++) {
            Matcher jm = JSON_CALL.matcher(lines[i]);
            if (jm.find()) {
                String name = jm.group(1);
                // 尝试从附近文本提取 arguments
                String args = extractLooseArgs(lines, i);
                String sig = name + "|" + args;
                if (!seenSignatures.contains(sig)) {
                    ToolCall tc = new ToolCall(null, name, args);
                    found.add(tc);
                    seenSignatures.add(sig);
                }
            }
        }

        return found;
    }

    /**
     * 从 DSML 格式的 body 中提取参数 JSON。
     * 解析 <parameter name="..." string="...">...</parameter> 标记。
     */
    private static String extractDsmlArgs(String body) {
        Map<String, Object> params = new LinkedHashMap<>();
        Pattern paramPat = Pattern.compile(
                "<parameter\\s+name=\"([^\"]+)\"\\s+string=\"([^\"]+)\">([\\s\\S]*?)</parameter>",
                Pattern.CASE_INSENSITIVE);
        Matcher m = paramPat.matcher(body);
        while (m.find()) {
            String pname = m.group(1);
            String val = m.group(3).trim();
            params.put(pname, val);
        }
        if (params.isEmpty()) return "{}";
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String, Object> e : params.entrySet()) {
            if (!first) sb.append(",");
            first = false;
            sb.append("\"").append(escapeJson(e.getKey())).append("\":\"")
                    .append(escapeJson(String.valueOf(e.getValue()))).append("\"");
        }
        sb.append("}");
        return sb.toString();
    }

    /**
     * 从文本附近提取 arguments JSON（简化实现）。
     * 从当前行往后找 arguments 字段，最多 5 行。
     */
    private static String extractLooseArgs(String[] lines, int idx) {
        // 从当前行往后找 arguments 字段
        Pattern argPat = Pattern.compile(
                "\"(?:arguments|tool_args)\"\\s*:\\s*(\\{[^}]+}|\"[^\"]+\")");
        for (int j = idx; j < Math.min(idx + 5, lines.length); j++) {
            Matcher m = argPat.matcher(lines[j]);
            if (m.find()) {
                return m.group(1);
            }
        }
        return "{}";
    }

    private static String escapeJson(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t");
    }

    /**
     * 工具调用数据
     */
    public record ToolCall(String id, String name, String arguments) {
    }
}
