package site.sorghum.loopra.tool;

import java.util.List;

/**
 * Agent 工具抽象基类——所有 Agent 可调用工具的顶层契约。
 * <p>
 * 每个工具必须声明其名称、描述、参数模式和执行逻辑，
 * 供 LLM 在 Tool-Use 协议中识别和调用。
 * </p>
 *
 * <h3>子类实现要点：</h3>
 * <ul>
 *   <li>{@link #getName()} —— 模型用来调用此工具的名称，如 "hashline_read"</li>
 *   <li>{@link #getDescription()} —— 完整的功能描述，会注入模型的系统提示</li>
 *   <li>{@link #getParameters()} —— JSON Schema 风格的参数定义</li>
 *   <li>{@link #execute(ToolContext)} —— 实际执行逻辑，接收参数上下文，返回结果</li>
 * </ul>
 *
 * @author Sorghum
 */
public abstract class AgentTool {

    /**
     * 工具名称——模型调用时使用的标识。
     * <p>例如：{@code "hashline_read"}、{@code "browser_screenshot"}。</p>
     */
    public abstract String getName();

    /**
     * 工具功能描述——会注入到模型的系统提示中。
     * <p>应包含：做什么、适用场景、参数说明、返回值说明、注意事项。</p>
     */
    public abstract String getDescription();

    /**
     * 工具参数定义列表——描述每个参数的类型、是否必填、含义。
     */
    public abstract List<ToolParameter> getParameters();

    /**
     * 执行工具逻辑。
     *
     * @param ctx 工具上下文，包含调用参数和文件系统路径
     * @return 执行结果
     */
    public abstract ToolResult execute(ToolContext ctx);

    /**
     * 工具是否为只读操作。只读工具在 Plan Mode 下仍然可用。
     * <p>默认 {@code false}，子类按需覆盖。</p>
     */
    public boolean isReadOnly() {
        return false;
    }

    /**
     * 工具是否豁免 Storm Breaker 限制。
     * <p>默认等价于 {@link #isReadOnly()}，即只读工具自动豁免风暴断路器。
     * 如果某个只读工具仍需要风暴检测，可覆盖此方法返回 {@code false}。
     * 如果某个写入工具需要豁免（极少见），可覆盖返回 {@code true}。</p>
     */
    public boolean isStormExempt() {
        return isReadOnly();
    }

    /**
     * 生成给模型看的工具定义摘要（用于系统提示）。
     * <p>
     * 默认返回空字符串，不生成自动规范。
     * 需要提供详细工具说明的子类应重写此方法。
     * </p>
     */
    public String toToolSpec() {
        return "";
    }

    @Override
    public String toString() {
        return getName();
    }
}
