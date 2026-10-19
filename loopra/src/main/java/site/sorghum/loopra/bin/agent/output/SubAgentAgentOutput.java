package site.sorghum.loopra.bin.agent.output;

import site.sorghum.loopra.tool.AgentOutput;
import site.sorghum.loopra.tool.ChoiceOption;
import site.sorghum.loopra.tool.LogLevel;

import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 子代理输出包装器 —— 将子代理的所有事件全部以 sub_ 前缀发送独立事件，
 * 不占用主代理的事件通道。前端通过独立 Modal 渲染这些事件。
 *
 * <p>每个子代理实例分配唯一的 {@code subId}（AtomicInteger 自增），
 * 嵌入所有事件 payload 的 {@code "subId"} 字段中，
 * 使得前端能在多个子代理并行运行时区分不同子代理的事件流。</p>
 *
 * <p>事件映射对照：<pre>
 *   主代理事件                 子代理事件（payload 均含 "subId"）
  *   onContentDelta(token)  →  sendEvent("sub_content", {"subId":..., "token":...})
  *   onContentComplete()    →  sendEvent("sub_complete", {"subId":...})
  *   onReasoningDelta(token)→  sendEvent("sub_reasoning", {"subId":..., "token":...})
  *   onToolCall(name,args)  →  sendEvent("sub_tool_call", {"subId":..., "name":..., "args":...})
  *   onToolResult(name,res) →  sendEvent("sub_tool_result", {"subId":..., "name":..., "result":...})
  *   onError(error)         →  sendEvent("sub_error", {"subId":..., "error":...})
  *   onUsage(...)           →  sendEvent("sub_usage", {"subId":..., ...})
  *   onChoice(options)      →  sendEvent("sub_choice", {"subId":..., "options":[...]})
  *   onLog(level, msg)      →  sendEvent("sub_log", {"subId":..., "level":..., "message":...})
 * </pre>
 * </p>
 *
 * <p>前端通过监听 type.startsWith("sub_") 来区分是子代理事件，
 * 使用 subId 将事件路由到对应的 blocks 数组中，在独立的子代理 Modal 中渲染。</p>
 *
 * @author Sorghum
 */
public class SubAgentAgentOutput implements AgentOutput {

    /** 全局子代理 ID 自增器 */
    private static final AtomicInteger SUB_ID_COUNTER = new AtomicInteger(0);

    private final AgentOutput delegate;
    private final String taskName;
    /** 子代理唯一标识（自增整数），嵌入所有事件 payload 用于前端区分并行子代理 */
    private final int subId;
    /** 所属子代理会话 id（由 SubAgent 挂载记录器时注入）：桌面端子代理会话面板按会话路由实时事件 */
    private String subSessionId = null;

    /**
     * @param delegate 父代理的 AgentOutput 实现（仅用于 sendEvent）
     * @param taskName 子代理的任务名称
     */
    public SubAgentAgentOutput(AgentOutput delegate, String taskName) {
        this.delegate = delegate;
        this.taskName = taskName != null ? taskName : "子代理";
        this.subId = SUB_ID_COUNTER.incrementAndGet();
    }

    /**
     * 获取子代理唯一标识（自增整数）。
     * 用于 HITL Broker 注册和前端事件路由。
     */
    public int getSubId() {
        return subId;
    }

    /** 绑定所属子代理会话 id（attach 记录器时注入，后续事件 payload 均携带）。 */
    public void setSubSessionId(String subSessionId) {
        this.subSessionId = subSessionId;
    }

    // ==================== JSON 拼接辅助 ====================

    /** 构建 subId 前缀 JSON 片段（含 subSessionId，供前端按会话路由） */
    private String subIdPrefix() {
        return subSessionId != null
            ? "{\"subId\":" + subId + ",\"subSessionId\":" + escapeJson(subSessionId) + ","
            : "{\"subId\":" + subId + ",";
    }

    /** 构建 subId 作为单独 JSON 对象（用于无其他 payload 的事件） */
    private String subIdOnly() {
        return subSessionId != null
            ? "{\"subId\":" + subId + ",\"subSessionId\":" + escapeJson(subSessionId) + "}"
            : "{\"subId\":" + subId + "}";
    }

    // ==================== 全部事件 → sub_xxx 独立通道 ====================

    @Override
    public void onContentDelta(String token) {
        delegate.sendEvent("sub_content", subIdPrefix() + "\"token\":" + escapeJson(token) + "}");
    }

    @Override
    public void onContentComplete() {
        delegate.sendEvent("sub_complete", subIdOnly());
    }

    @Override
    public void onReasoningDelta(String token) {
        delegate.sendEvent("sub_reasoning", subIdPrefix() + "\"token\":" + escapeJson(token) + "}");
    }

    @Override
    public void onReasoning(String reasoning) {
        if (reasoning != null && !reasoning.isEmpty()) {
            delegate.sendEvent("sub_reasoning", subIdPrefix() + "\"token\":" + escapeJson(reasoning) + "}");
        }
    }

    @Override
    public void onReasoningStarted() {
        delegate.sendEvent("sub_reasoning_started", subIdOnly());
    }

    @Override
    public void onToolCall(String name, String args) {
         // JSON：{"subId":...,"name":"xxx","args":{...}}
        StringBuilder sb = new StringBuilder(subIdPrefix());
        sb.append("\"name\":").append(escapeJson(name));
        sb.append(",\"args\":").append(args != null ? args : "{}");
        sb.append("}");
        delegate.sendEvent("sub_tool_call", sb.toString());
    }

    @Override
    public void onToolCall(String id, String name, String args) {
        StringBuilder event = new StringBuilder(subIdPrefix());
        event.append("\"toolCallId\":").append(escapeJson(id));
        event.append(",\"name\":").append(escapeJson(name));
        event.append(",\"args\":").append(args == null ? "{}" : args).append("}");
        delegate.sendEvent("sub_tool_call", event.toString());
    }

    @Override
    public void onToolResult(String id, String name, String result, boolean failed) {
        StringBuilder event = new StringBuilder(subIdPrefix());
        event.append("\"toolCallId\":").append(escapeJson(id));
        event.append(",\"name\":").append(escapeJson(name));
        event.append(",\"result\":").append(escapeJson(result == null ? "" : result));
        event.append(",\"status\":").append(escapeJson(failed ? "failed" : "completed")).append("}");
        delegate.sendEvent("sub_tool_result", event.toString());
    }

    @Override
    public void onToolResult(String name, String result) {
         // JSON：{"subId":...,"name":"xxx","result":"..."}
        StringBuilder sb = new StringBuilder(subIdPrefix());
        sb.append("\"name\":").append(escapeJson(name));
        sb.append(",\"result\":").append(escapeJson(result != null ? result : ""));
        sb.append("}");
        delegate.sendEvent("sub_tool_result", sb.toString());
    }

    @Override
    public void onUsage(int promptTokens, int completionTokens, int totalTokens,
                        int cacheHit, int cacheMiss) {
        StringBuilder sb = new StringBuilder(subIdPrefix());
        sb.append("\"promptTokens\":").append(promptTokens).append(",");
        sb.append("\"completionTokens\":").append(completionTokens).append(",");
        sb.append("\"totalTokens\":").append(totalTokens).append(",");
        sb.append("\"cacheHit\":").append(cacheHit).append(",");
        sb.append("\"cacheMiss\":").append(cacheMiss);
        sb.append("}");
        delegate.sendEvent("sub_usage", sb.toString());
    }

    @Override
    public void onUsage(String model, int promptTokens, int completionTokens, int totalTokens,
                        int cacheHit, int cacheMiss) {
        StringBuilder sb = new StringBuilder(subIdPrefix());
        sb.append("\"model\":").append(escapeJson(model)).append(",");
        sb.append("\"promptTokens\":").append(promptTokens).append(",");
        sb.append("\"completionTokens\":").append(completionTokens).append(",");
        sb.append("\"totalTokens\":").append(totalTokens).append(",");
        sb.append("\"cacheHit\":").append(cacheHit).append(",");
        sb.append("\"cacheMiss\":").append(cacheMiss);
        sb.append("}");
        delegate.sendEvent("sub_usage", sb.toString());
    }

    @Override
    public void onError(String error) {
        delegate.sendEvent("sub_error", subIdPrefix() + "\"error\":" + escapeJson(error) + "}");
    }

    @Override
    public void onLog(LogLevel level, String message) {
        delegate.sendEvent("sub_log",
                subIdPrefix() + "\"level\":\"" + level.name() + "\",\"message\":" + escapeJson(message) + "}");
    }

    @Override
    public void onChoice(List<ChoiceOption> options) {
        onChoice(options, null, null);
    }

    @Override
    public void onChoice(List<ChoiceOption> options, String title, String description) {
        if (options != null && !options.isEmpty()) {
            StringBuilder sb = new StringBuilder(subIdPrefix());
            if (title != null && !title.isEmpty()) {
                sb.append("\"title\":").append(escapeJson(title)).append(",");
            }
            if (description != null && !description.isEmpty()) {
                sb.append("\"description\":").append(escapeJson(description)).append(",");
            }
            sb.append("\"options\":[");
            for (int i = 0; i < options.size(); i++) {
                if (i > 0) sb.append(",");
                sb.append("{\"title\":").append(escapeJson(options.get(i).title()));
                sb.append(",\"value\":").append(escapeJson(options.get(i).value()));
                sb.append("}");
            }
            sb.append("]}");
            delegate.sendEvent("sub_choice", sb.toString());
        }
    }

    // ==================== 委托基础方法 ====================

    @Override
    public void sendEvent(String type, String data) {
        delegate.sendEvent(type, data);
    }

    // ==================== 工具方法 ====================

    private static String escapeJson(String s) {
        if (s == null) return "\"\"";
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
                }
            }
        }
        sb.append("\"");
        return sb.toString();
    }
}
