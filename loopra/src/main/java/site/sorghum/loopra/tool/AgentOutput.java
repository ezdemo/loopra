package site.sorghum.loopra.tool;

import org.noear.snack4.ONode;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Agent 输出抽象接口 —— 所有 Agent 向外输出的内容都通过此接口发送。
 * <p>
 * 将"输出"与"业务逻辑"解耦，当前实现 {@code ConsoleAgentOutput} 打印到控制台。
 * 可替换为其他实现（如 WebSocket SSE、日志文件、测试 Mock 等），
 * 实现不同场景下的输出处理。
 * </p>
 *
 * @author Sorghum
 */
public interface AgentOutput {

    // ==================== 流式输出 ====================

    /**
     * 无操作的空实现 —— 关闭所有输出
     */
    AgentOutput NOOP = NoOpAgentOutput.INSTANCE;

    /**
     * 流式内容增量（模型回复的文本片段）
     */
    void onContentDelta(String token);

    /**
     * 流式内容结束（模型回复完成）
     */
    void onContentComplete();

    /**
     * 流式思考增量（reasoning_content 的文本片段）
     */
    void onReasoningDelta(String token);

    // ==================== 事件 ====================

    /**
     * 完整思考内容（非流式场景，如无 tool_calls 时模型返回纯思考）
     */
    void onReasoning(String reasoning);

    /** 模型已经开始思考，但思考文本此刻可能尚不可用。 */
    default void onReasoningStarted() {
    }

    /**
     * 工具调用事件
     */
    void onToolCall(String name, String args);

    /** Stable engine call ID; legacy outputs retain their name-only callbacks. */
    default void onToolCall(String toolCallId, String name, String args) {
        onToolCall(name, args);
    }

    /** ACP tools may acquire their title and arguments after their initial announcement. */
    default void onToolUpdate(String toolCallId, String name, String args) {
        Map<String, Object> event = new java.util.LinkedHashMap<>();
        event.put("toolCallId", toolCallId); event.put("name", name);
        if (args != null) event.put("args", args);
        sendEvent("tool_update", ONode.serialize(event));
    }

    /**
     * 工具结果事件
     */
    void onToolResult(String name, String result);

    default void onToolResult(String toolCallId, String name, String result, boolean failed) {
        onToolResult(name, result);
    }

    /**
     * Token 用量回调
     */
    void onUsage(int promptTokens, int completionTokens, int totalTokens,
                 int cacheHit, int cacheMiss);

    /**
     * Token 用量回调（含模型名称，用于按模型分别计费）
     */
    default void onUsage(String model, int promptTokens, int completionTokens, int totalTokens,
                         int cacheHit, int cacheMiss) {
        onUsage(promptTokens, completionTokens, totalTokens, cacheHit, cacheMiss);
    }

    /** 生成速率事件；旧输出实现仍可通过自定义事件消费相同 JSON。 */
    default void onTokenSpeed(TokenSpeed speed) {
        sendEvent("token_speed", ONode.serialize(speed));
    }

    // ==================== 日志 & 消息 ====================

    /**
     * 错误信息
     */
    void onError(String error);

    /**
     * 日志消息（调试/信息/警告/错误日志）
     */
    void onLog(LogLevel level, String message);

    // ==================== 空实现 ====================

    /**
     * 选项列表（如 HITL 审批：同意/拒绝）
     */
    void onChoice(List<ChoiceOption> options);

    /**
     * 选项列表（带标题和描述）。
     * <p>默认实现委托给 {@link #onChoice(List)}，子类可覆盖以传递更多上下文。</p>
     *
     * @param options     选项列表
     * @param title       标题（如 "read、write"）
     * @param description 描述（如工具参数详情）
     */
    default void onChoice(List<ChoiceOption> options, String title, String description) {
        onChoice(options);
    }

    // ==================== 交互式询问 ====================

    /**
     * 向用户展示问题并等待选择回答。
     * <p>
     * 默认实现格式化问题与选项并通过 {@link #onLog} 输出，返回格式化文本。
     * 各输出实现可覆盖此方法以提供真正的交互式体验：
     * <ul>
     *   <li>{@code ConsoleAgentOutput} → 打印选项 + 读取 stdin</li>
     *   <li>{@code SseAgentOutput} → 通过 SSE 推送 + 等待用户回复</li>
     * </ul>
     * </p>
     *
     * @param question    问题描述
     * @param options     选项列表，每项为 {@code {"title":"...", "summary":"..."}} 或字符串
     * @param allowCustom 是否允许用户自定义输入
     * @return 用户的选择结果
     */
    default String ask(String question, List<Map<String, Object>> options, boolean allowCustom) {
        if (options == null) {
            return "[no options provided]";
        }
        // 1. 统一转为 ChoiceOption 列表，通过 onChoice() 渲染
        //    自定义输出实现（如 SseAgentOutput）可通过重写 onChoice() 接管 UI 展示
        final List<ChoiceOption> choiceOptions = new ArrayList<>();
        for (Map<String, Object> opt : options) {
            final String title = (String) opt.getOrDefault("title", "");
            final String value = (String) opt.getOrDefault("value", title);
            choiceOptions.add(new ChoiceOption(value, title));
        }

        // 2. 默认回退：格式化问题与选项为纯文本
        final StringBuilder sb = new StringBuilder();
        sb.append("┌─ ").append(question).append("\n");
        for (int i = 0; i < options.size(); i++) {
            final Map<String, Object> opt = options.get(i);
            final String label = (String) opt.getOrDefault("title", "option-" + (i + 1));
            sb.append("│ ").append(i + 1).append(". ").append(label);
            final String summary = (String) opt.get("summary");
            if (summary != null) sb.append(" — ").append(summary);
            sb.append("\n");
        }
        if (allowCustom) {
            sb.append("│ 0. (type your own answer)\n");
        }
        sb.append("└─ 输入编号选择");

        if (!choiceOptions.isEmpty()) {
            onChoice(choiceOptions);
        }
        return sb.toString();
    }

    // ==================== 自定义事件 ====================

    /**
     * 发送自定义事件（如 sub_start / sub_end 子代理边界事件）。
     * <p>
     * 默认无操作，各实现类可覆盖此方法实现特定处理。
     * </p>
     *
     * @param type 事件类型，如 "sub_start", "sub_end"
     * @param data JSON 格式的事件数据
     */
    default void sendEvent(String type, String data) {
        // 默认无操作
    }
}
