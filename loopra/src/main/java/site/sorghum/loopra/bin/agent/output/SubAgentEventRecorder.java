package site.sorghum.loopra.bin.agent.output;

import site.sorghum.loopra.bin.session.SubAgentSessionStore;
import site.sorghum.loopra.tool.AgentOutput;
import site.sorghum.loopra.tool.ChoiceOption;
import site.sorghum.loopra.tool.LogLevel;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 子代理事件记录器 —— 装饰 {@link SubAgentAgentOutput}，在保持 SSE 实时流不变的同时，
 * 将子代理执行过程以段级粒度写入 {@link SubAgentSessionStore}（子代理会话，挂在主会话下）。
 * <p>
 * 落盘粒度对齐主会话消息级语义，避免流式 delta 高频写盘：
 * <ul>
 *   <li>reasoning 流式 delta 先累积，在工具调用/正文输出/结束时作为完整段落盘一次；</li>
 *   <li>正文 delta 累积，在 {@link #onContentComplete()} 时作为完整段落实盘一次；</li>
 *   <li>工具调用/结果、错误、HITL 选择为事件级，即时落盘。</li>
 * </ul>
 * 首条事件为 sub_start（含 task/profile/subId 元数据，同时经 SSE 推送供前端感知开始），
 * 末条为 sub_end（状态 + 结束时间）。
 * </p>
 *
 * @author Sorghum
 */
public class SubAgentEventRecorder implements AgentOutput {

    private final SubAgentSessionStore store;
    private final String parentSessionName;
    private final String subSessionId;

    /** 绑定的子代理输出（SubAgentAgentOutput），attach 后非空 */
    private AgentOutput delegate;
    private boolean attached = false;
    private boolean ended = false;
    private int subId = 0;

    /** 流式思考 delta 累积 */
    private final StringBuilder reasoningBuffer = new StringBuilder();
    /** 流式正文 delta 累积 */
    private final StringBuilder contentBuffer = new StringBuilder();

    public SubAgentEventRecorder(SubAgentSessionStore store, String parentSessionName, String subSessionId) {
        this.store = store;
        this.parentSessionName = parentSessionName;
        this.subSessionId = subSessionId;
    }

    /**
     * 绑定输出委托并写入 sub_start（落盘 + SSE 推送，前端可感知子代理开始）。
     * 重置结束标记：同一会话继续对话（新一轮执行）时再次 attach 会续写新一轮 sub_start。
     *
     * @param task  会话名称（name + 任务首句，多轮稳定，兼容老数据以纯任务兜底）
     * @param name  子代理名字（人名/二次元名字等，可为 null 表示旧数据无 name）
     * @param title 会话标题（任务首句，可为 null）
     */
    public void attach(AgentOutput delegate, String task, String name, String title, int subId) {
        this.delegate = delegate;
        this.subId = subId;
        this.attached = true;
        this.ended = false;
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("subId", subId);
        payload.put("subSessionId", subSessionId);
        payload.put("task", task);
        if (name != null) payload.put("name", name);
        if (title != null) payload.put("title", title);
        payload.put("startedAt", System.currentTimeMillis());
        record("sub_start", payload);
        delegate.sendEvent("sub_start", json(payload));
    }

    /**
     * 写 sub_end（幂等；未挂载或已结束时为 no-op）。
     *
     * @param status completed / aborted / error
     */
    public void end(String status) {
        if (!attached || ended) return;
        ended = true;
        flushReasoning();
        flushContent();
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("subId", subId);
        payload.put("subSessionId", subSessionId);
        payload.put("status", status);
        payload.put("endedAt", System.currentTimeMillis());
        record("sub_end", payload);
        delegate.sendEvent("sub_end", json(payload));
    }

    public boolean isAttached() {
        return attached;
    }

    /** 所属子代理会话 id（供 SubAgent 注入到实时事件 payload）。 */
    public String getSubSessionId() {
        return subSessionId;
    }

    // ==================== 落盘辅助 ====================

    private void record(String type, Map<String, Object> payload) {
        store.record(parentSessionName, subSessionId, type, payload);
    }

    /** 思考段累积到工具调用/输出前落盘一次。 */
    private void flushReasoning() {
        if (reasoningBuffer.length() == 0) return;
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("subId", subId);
        payload.put("subSessionId", subSessionId);
        payload.put("content", reasoningBuffer.toString());
        record("sub_reasoning", payload);
        reasoningBuffer.setLength(0);
    }

    /** 正文段在输出完成时落盘一次。 */
    private void flushContent() {
        if (contentBuffer.length() == 0) return;
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("subId", subId);
        payload.put("subSessionId", subSessionId);
        payload.put("content", contentBuffer.toString());
        record("sub_content", payload);
        contentBuffer.setLength(0);
    }

    private static String json(Map<String, Object> payload) {
        org.noear.snack4.ONode node = org.noear.snack4.ONode.ofJson("{}");
        for (Map.Entry<String, Object> e : payload.entrySet()) {
            node.set(e.getKey(), e.getValue());
        }
        return node.toJson();
    }

    // ==================== 流式输出（delta 累积，不落盘） ====================

    @Override
    public void onContentDelta(String token) {
        delegate.onContentDelta(token);
        contentBuffer.append(token);
    }

    @Override
    public void onContentComplete() {
        delegate.onContentComplete();
        // 正文完整段落盘（思考残余一并收尾）
        flushReasoning();
        flushContent();
    }

    @Override
    public void onReasoningDelta(String token) {
        delegate.onReasoningDelta(token);
        reasoningBuffer.append(token);
    }

    // ==================== 事件（即时落盘 + 转发） ====================

    @Override
    public void onReasoning(String reasoning) {
        delegate.onReasoning(reasoning);
        reasoningBuffer.append(reasoning);
    }

    @Override
    public void onReasoningStarted() {
        delegate.onReasoningStarted();
    }

    @Override
    public void onToolCall(String name, String args) {
        delegate.onToolCall(name, args);
        flushReasoning();
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("subId", subId);
        payload.put("subSessionId", subSessionId);
        payload.put("name", name);
        payload.put("args", parseJson(args));
        payload.put("startedAt", System.currentTimeMillis());
        record("sub_tool_call", payload);
    }

    @Override
    public void onToolCall(String id, String name, String args) {
        delegate.onToolCall(id, name, args);
        flushReasoning();
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("subId", subId);
        payload.put("subSessionId", subSessionId);
        payload.put("toolCallId", id);
        payload.put("name", name);
        payload.put("args", parseJson(args));
        payload.put("startedAt", System.currentTimeMillis());
        record("sub_tool_call", payload);
    }

    @Override
    public void onToolResult(String id, String name, String result, boolean failed) {
        delegate.onToolResult(id, name, result, failed);
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("subId", subId);
        payload.put("subSessionId", subSessionId);
        payload.put("toolCallId", id);
        payload.put("name", name);
        payload.put("result", result == null ? "" : result);
        payload.put("status", failed ? "failed" : "completed");
        payload.put("finishedAt", System.currentTimeMillis());
        record("sub_tool_result", payload);
    }

    @Override
    public void onToolResult(String name, String result) {
        delegate.onToolResult(name, result);
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("subId", subId);
        payload.put("subSessionId", subSessionId);
        payload.put("name", name);
        payload.put("result", result != null ? result : "");
        payload.put("finishedAt", System.currentTimeMillis());
        record("sub_tool_result", payload);
    }

    @Override
    public void onError(String error) {
        delegate.onError(error);
        flushReasoning();
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("subId", subId);
        payload.put("subSessionId", subSessionId);
        payload.put("error", error);
        record("sub_error", payload);
    }

    @Override
    public void onChoice(List<ChoiceOption> options) {
        onChoice(options, null, null);
    }

    @Override
    public void onChoice(List<ChoiceOption> options, String title, String description) {
        delegate.onChoice(options, title, description);
        flushReasoning();
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("subId", subId);
        payload.put("subSessionId", subSessionId);
        if (title != null && !title.isEmpty()) payload.put("title", title);
        if (description != null && !description.isEmpty()) payload.put("description", description);
        List<Map<String, String>> optionList = new ArrayList<>();
        if (options != null) {
            for (ChoiceOption opt : options) {
                Map<String, String> item = new LinkedHashMap<>();
                item.put("title", opt.title());
                item.put("value", opt.value());
                optionList.add(item);
            }
        }
        payload.put("options", optionList);
        record("sub_choice", payload);
    }

    // ==================== 用量 / 日志（转发不落盘） ====================

    @Override
    public void onUsage(int promptTokens, int completionTokens, int totalTokens,
                        int cacheHit, int cacheMiss) {
        delegate.onUsage(promptTokens, completionTokens, totalTokens, cacheHit, cacheMiss);
    }

    @Override
    public void onUsage(String model, int promptTokens, int completionTokens, int totalTokens,
                        int cacheHit, int cacheMiss) {
        delegate.onUsage(model, promptTokens, completionTokens, totalTokens, cacheHit, cacheMiss);
    }

    @Override
    public void onLog(LogLevel level, String message) {
        delegate.onLog(level, message);
    }

    @Override
    public void sendEvent(String type, String data) {
        delegate.sendEvent(type, data);
    }

    @Override
    public String ask(String question, List<Map<String, Object>> options, boolean allowCustom) {
        return delegate.ask(question, options, allowCustom);
    }

    /** args 可能为 JSON 字符串（保持原样落盘，前端重建时 parse），解析失败按字符串存。 */
    private static Object parseJson(String args) {
        if (args == null || args.isBlank()) return "";
        try {
            org.noear.snack4.ONode node = org.noear.snack4.ONode.ofJson(args);
            if (node.isObject()) return site.sorghum.loopra.bin.util.ONodeUtil.toMap(node);
            if (node.isArray()) return site.sorghum.loopra.bin.util.ONodeUtil.toList(node);
        } catch (Exception ignored) {
            // 非 JSON（如普通字符串），按原样保存
        }
        return args;
    }
}
