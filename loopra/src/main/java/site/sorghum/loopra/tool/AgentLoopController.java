package site.sorghum.loopra.tool;

import site.sorghum.loopra.bin.agent.spi.AgentConfig;
import site.sorghum.loopra.bin.agent.spi.SessionUsageSink;
import site.sorghum.loopra.bin.model.LoopraModelProvider;
import site.sorghum.loopra.bin.tool.ToolRegistry;

/**
 * AgentLoop 控制接口 —— 工具通过此接口影响推理循环的控制流。
 * <p>
 * 由 {@code AgentLoop} 实现并注入到 {@link ToolContext} 中，
 * 工具在执行过程中可通过 {@link ToolContext#getLoopController()} 获取此引用。
 * </p>
 *
 * <h3>使用示例</h3>
 * <pre>{@code
 * AgentLoopController ctrl = ctx.getLoopController();
 * if (ctrl != null) {
 *     ctrl.getOutput().onLog(LogLevel.INFO, "进度信息");  // 直接输出
 *     ctrl.requestStop();                                 // 停止推理
 *     ctrl.injectUserMessage("继续...");                  // 注入消息
 * }
 * }</pre>
 *
 * @author Sorghum
 */
public interface AgentLoopController {

    /**
     * 获取 Agent 输出通道。
     * <p>工具可通过此接口推送日志、错误、自定义事件等内容到前端/控制台。
     * 返回 {@code null} 时表示无关联的输出通道（如后台任务、测试环境）。</p>
     */
    AgentOutput getOutput();

    /**
     * 停止推理循环
     */
    void requestStop();

    /**
     * 在下一轮循环前注入一条用户消息。
     *
     * @param message 要注入的用户消息内容
     */
    void injectUserMessage(String message);

    /**
     * 向下游推送自定义事件。
     * <p>事件通过 {@code AgentOutput.sendEvent(type, data)} 发送。</p>
     *
     * @param type 事件类型标识符，如 {@code "build_progress"}
     * @param data JSON 格式的事件数据
     */
    default void emitEvent(String type, String data) {
        AgentOutput out = getOutput();
        if (out != null) {
            out.sendEvent(type, data);
        }
    }

    /**
     * 任务完成 —— 工具调用此方法声明所有任务已完成，推理循环将在当前工具执行结束后退出。
     * <p>content 将作为最终回复返回给用户。</p>
     *
     * @param content AI 的最终回答内容
     */
    default void finish(String content) {
        // 默认空实现，AgentLoop 中会覆盖此方法
    }

    /**
     * 检查用户是否已请求中断/停止。
     * <p>工具（尤其是长时间运行的工具如 sub_agent/bash）应该定期检查此标志，
     * 如果返回 true 应尽快停止执行并返回。</p>
     *
     * @return true 表示用户已请求停止
     */
    default boolean isAbortRequested() {
        return false;
    }

    /**
     * 获取工具注册类
     */
    ToolRegistry getToolRegistry();

    /**
     * 获取会话用量上报通道（可为 null，表示无会话持久化）。
     * <p>子代理通过此接口向父会话上报 token 用量。</p>
     */
    default SessionUsageSink getSessionUsageSink() {
        return null;
    }

    /** 获取当前循环使用的模型 Provider，供子代理创建隔离副本。 */
    default LoopraModelProvider getModelProvider() {
        return null;
    }

    /** 获取当前循环配置，供子代理继承超时等运行参数。 */
    default AgentConfig getAgentConfig() {
        return null;
    }

    /** 注册当前工具的显式取消动作。 */
    default void registerToolCancellation(Runnable cancellation) {
    }

    /** 清除当前工具的显式取消动作。 */
    default void clearToolCancellation() {
    }

    /** 注册跨工具调用持续存在的可取消资源（例如 bash_start 启动的进程会话）。 */
    default void registerAbortResource(String resourceId, Runnable cancellation) {
    }

    /** 注销已完成的可取消资源。 */
    default void clearAbortResource(String resourceId) {
    }

    /**
     * 获取当前 HITL 模式状态。
     * <p>保留该布尔接口用于兼容只区分开启/关闭的调用方。</p>
     *
     * @return true 表示 HITL 审批或自动模式已开启
     */
    default boolean isHitlMode() {
        return false;
    }

    /**
     * 获取当前 HITL 的完整模式，供子代理精确继承父代理设置。
     * <p>旧控制器若只实现了 {@link #isHitlMode()}，默认映射为
     * {@code approval/free}，保持二态行为兼容。</p>
     *
     * @return {@code free}、{@code approval} 或 {@code auto}
     */
    default String getHitlMode() {
        return isHitlMode() ? "approval" : "free";
    }

    /**
     * 当前循环是否处于计划模式（仅允许只读工具）。
     * <p>计划模式下工具列表被过滤为只读集合，非只读调用会被拒绝。
     * 子代理通过此接口继承父代理的计划模式约束。</p>
     */
    default boolean isPlanMode() {
        return false;
    }

    /**
     * 提交执行计划供用户审查（计划模式产物）。
     * <p>由 {@code submit_plan} 工具调用；实现方应保存计划并在用户批准后
     * 作为执行依据注入后续对话。默认空实现（如测试桩、无计划能力的控制器）。</p>
     *
     * @param planMarkdown 计划内容（Markdown 文本）
     */
    default void submitPlan(String planMarkdown) {
        // 默认空实现，AgentLoop 中会覆盖此方法
    }
}
