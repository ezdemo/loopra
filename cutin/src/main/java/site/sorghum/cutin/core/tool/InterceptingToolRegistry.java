package site.sorghum.cutin.core.tool;

import site.sorghum.cutin.core.context.LoopContext;
import site.sorghum.cutin.core.loop.InterceptContext;
import site.sorghum.cutin.core.loop.InterceptDecision;
import site.sorghum.cutin.core.loop.InterceptPoint;
import site.sorghum.cutin.core.loop.InterceptionResult;
import site.sorghum.cutin.core.loop.InterceptorRegistry;
import site.sorghum.cutin.core.loop.LoopAbortException;
import site.sorghum.cutin.core.loop.LoopSuspendException;

import java.util.List;
import java.util.Optional;

/**
 * 带完整拦截链的工具注册表。
 *
 * <p>在真实工具执行前后分别运行 {@code BEFORE_TOOL} / {@code AFTER_TOOL}，
 * 工具失败时运行 {@code ON_TOOL_ERROR}。拒绝、审批、限流等策略由
 * {@code BEFORE_TOOL} 拦截器实现。</p>
 */
public final class InterceptingToolRegistry implements ToolRegistry {

    /** 真正持有工具的下层注册表。 */
    private final ToolRegistry delegate;
    /** 生命周期拦截器注册表。 */
    private final InterceptorRegistry interceptors;

    /** 包装一个基础工具注册表，并接入拦截链。 */
    public InterceptingToolRegistry(ToolRegistry delegate, InterceptorRegistry interceptors) {
        this.delegate = delegate;
        this.interceptors = interceptors;
    }

    /** {@inheritDoc} */
    @Override
    public void register(Tool tool) {
        delegate.register(tool);
    }

    /** {@inheritDoc} */
    @Override
    public Optional<Tool> find(String toolId) {
        return delegate.find(toolId);
    }

    /** {@inheritDoc} */
    @Override
    public List<ToolDefinition> definitions() {
        return delegate.definitions();
    }

    /**
     * 执行一次带拦截链的工具调用。
     *
     * <p>流程：BEFORE_TOOL 拦截 → 真实执行 →
     * 失败时 ON_TOOL_ERROR → AFTER_TOOL 拦截。任意拦截点都可以返回
     * 替换后的 {@link ToolResult} 或触发中止/挂起。</p>
     */
    @Override
    public ToolResult call(ToolCall call, LoopContext context) {
        InterceptionResult before = interceptors.run(
            InterceptPoint.BEFORE_TOOL,
            new InterceptContext(InterceptPoint.BEFORE_TOOL, null, null, context, call)
        );
        throwIfTerminal(before.decision());
        if (before.payload() instanceof ToolResult replacement) {
            return replacement;
        }

        ToolResult result = delegate.call(call, before.context());
        if (!result.ok()) {
            InterceptionResult error = interceptors.run(
                InterceptPoint.ON_TOOL_ERROR,
                new InterceptContext(InterceptPoint.ON_TOOL_ERROR, null, null, before.context(), result)
            );
            throwIfTerminal(error.decision());
            if (error.payload() instanceof ToolResult replacement) {
                result = replacement;
            }
        }

        InterceptionResult after = interceptors.run(
            InterceptPoint.AFTER_TOOL,
            new InterceptContext(InterceptPoint.AFTER_TOOL, null, null, before.context(), result)
        );
        throwIfTerminal(after.decision());
        return after.payload() instanceof ToolResult replacement ? replacement : result;
    }

    /** 将拦截器返回的中止/挂起决策转换为对应的循环异常。 */
    private void throwIfTerminal(InterceptDecision decision) {
        if (decision.isAbort()) {
            throw new LoopAbortException(decision.reason());
        }
        if (decision.isSuspend()) {
            throw new LoopSuspendException(decision.reason());
        }
    }
}
