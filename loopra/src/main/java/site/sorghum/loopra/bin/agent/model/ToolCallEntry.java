package site.sorghum.loopra.bin.agent.model;

import org.noear.snack4.ONode;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 工具调用条目 —— 替代 Map&lt;String, Object&gt; 表示单个工具调用的强类型封装。
 * <p>
 * 包含工具调用的 ID、名称和参数。
 * {@code arguments} 内部为 JSON 字符串，反序列化为 JSON 对象输出。
 * </p>
 *
 * @param id                工具调用 ID（由 API 返回或自动生成）
 * @param name              工具名称
 * @param arguments         工具参数（内部 String，序列化时由 Snack4 自动输出为 JSON 对象）
 * @param responseReasoning Responses API 推理 item 的原始 JSON；其他协议为 null
 * @author Sorghum
 */
public record ToolCallEntry(String id, String name, Object arguments, String responseReasoning) {

    public ToolCallEntry(String id, String name, Object arguments) {
        this(id, name, arguments, null);
    }

    /**
     * 转换为 Map（兼容旧的 JSON 序列化路径）。
     */
    public Map<String, Object> toMap() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("name", name);
        m.put("arguments", arguments);
        if (responseReasoning != null) m.put("response_reasoning", responseReasoning);
        return m;
    }

    public static List<ToolCallEntry> fromToolCalls(ONode toolCalls) {
        List<ToolCallEntry> tcList = new ArrayList<>();
        if (toolCalls == null || !toolCalls.isArray()) return tcList;
        for (ONode tc : toolCalls.getArray()) {
            String tcId = tc.get("id").getString();
            ONode func = tc.get("function");
            String tcName = func.get("name").getString();
            if (tcName == null || tcName.isEmpty()) continue;
            String tcArgs = func.get("arguments").getString();
            if (tcArgs == null) tcArgs = "{}";
            String responseReasoning = tc.get("response_reasoning").getString();
            tcList.add(new ToolCallEntry(tcId, tcName, tcArgs, responseReasoning));
        }
        return tcList;
    }

    public static Map<String, Object> parseArguments(Object arguments) {
        if (arguments instanceof String json) {
            if (json.isBlank()) return Map.of();
            try {
                arguments = ONode.ofJson(json).toBean(Map.class);
            } catch (RuntimeException ignored) {
                // 格式错误的参数按空处理。
                return Map.of();
            }
        }
        if (!(arguments instanceof Map<?, ?> map)) return Map.of();
        Map<String, Object> result = new HashMap<>();
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            result.put(String.valueOf(entry.getKey()), entry.getValue());
        }
        return result;
    }
}
