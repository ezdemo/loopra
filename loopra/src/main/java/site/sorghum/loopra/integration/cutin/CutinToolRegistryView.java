package site.sorghum.loopra.integration.cutin;

import site.sorghum.cutin.core.context.LoopContext;
import site.sorghum.cutin.core.tool.Tool;
import site.sorghum.cutin.core.tool.ToolCall;
import site.sorghum.cutin.core.tool.ToolDefinition;
import site.sorghum.cutin.core.tool.ToolNotFoundException;
import site.sorghum.cutin.core.tool.ToolRegistry;
import site.sorghum.cutin.core.tool.ToolResult;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * 基于 Loopra 工具表的实时 cutin {@link ToolRegistry} 视图。
 * <p>
 * Loopra 的 {@code ToolRegistry} 持有 Solon 工具定义，并把每次注册/刷新
 * 同步进该视图；Loopra 热刷新内容时，视图在 cutin 引擎内保持稳定。
 * </p>
 * <p>
 * 视图分两区：Loopra 工具表同步区（{@link #setTools} 全量替换）与外部
 * 注册区（{@link #register}/{@link #unregister} 管理，如拓展包桥接与
 * cutin 插件贡献的工具）。同步区刷新不会清除外部注册工具，避免拓展包
 * 工具被 loopra 工具表同步整体抹掉；同名冲突时外部注册优先，且重复
 * 注册以最新实例为准（插件热重启后新桥接实例必须生效）。
 * </p>
 */
public final class CutinToolRegistryView implements ToolRegistry {

    /** Loopra 工具表同步区（setTools 全量替换）。 */
    private final ConcurrentHashMap<String, Tool> loopraTools = new ConcurrentHashMap<>();
    /** Loopra 同步区有序列表（保持注入顺序）。 */
    private final CopyOnWriteArrayList<Tool> loopraOrdered = new CopyOnWriteArrayList<>();
    /** 外部注册区（register/unregister 管理，setTools 不清除）。 */
    private final ConcurrentHashMap<String, Tool> extTools = new ConcurrentHashMap<>();
    /** 外部注册区有序列表。 */
    private final CopyOnWriteArrayList<Tool> extOrdered = new CopyOnWriteArrayList<>();

    /** 内容变更通知（用于失效 ToolRegistry 的 OpenAI tools 缓存）。 */
    private volatile Runnable onChange;

    /** 设置内容变更回调（register/unregister/setTools/clearAll 时触发）。 */
    public void setOnChange(Runnable onChange) {
        this.onChange = onChange;
    }

    private void fireChange() {
        Runnable callback = onChange;
        if (callback != null) {
            callback.run();
        }
    }

    /** 以 Loopra 工具表整体替换同步区；外部注册区不受影响。 */
    public void setTools(Collection<? extends Tool> newTools) {
        loopraTools.clear();
        loopraOrdered.clear();
        for (Tool tool : newTools) {
            if (extTools.containsKey(tool.id())) {
                continue; // 外部注册的同 id 工具优先，不覆盖
            }
            Tool previous = loopraTools.putIfAbsent(tool.id(), tool);
            if (previous == null) {
                loopraOrdered.add(tool);
            }
        }
        fireChange();
    }

    /** 清空全部工具（含外部注册区）——网关下线等“全部下线”场景使用。 */
    public void clearAll() {
        loopraTools.clear();
        loopraOrdered.clear();
        extTools.clear();
        extOrdered.clear();
        fireChange();
    }

    @Override
    public void register(Tool tool) {
        // 覆盖式注册：插件热重启（stop→start）时 DefaultLoopRegistrar 会把旧实例
        // 恢复进外部区，若此处 putIfAbsent 拒绝新实例，视图将一直执行过期工具定义。
        Tool previous = extTools.put(tool.id(), tool);
        if (previous != tool) {
            if (previous != null) {
                extOrdered.remove(previous);
            }
            extOrdered.add(tool);
            // 外部注册优先：让位同 id 的 loopra 同步工具，避免定义重复
            if (loopraTools.remove(tool.id()) != null) {
                loopraOrdered.removeIf(t -> t.id().equals(tool.id()));
            }
            fireChange();
        }
    }

    @Override
    public boolean unregister(String toolId, Tool tool) {
        boolean removed = extTools.remove(toolId, tool);
        if (removed) {
            extOrdered.remove(tool);
            fireChange();
        }
        return removed;
    }

    /** 外部注册区工具（拓展包桥接、插件贡献），供模型可见性合并使用。 */
    public List<Tool> externalTools() {
        return List.copyOf(extOrdered);
    }

    @Override
    public Optional<Tool> find(String toolId) {
        Tool tool = extTools.get(toolId);
        if (tool == null) {
            tool = loopraTools.get(toolId);
        }
        return Optional.ofNullable(tool);
    }

    @Override
    public List<ToolDefinition> definitions() {
        List<ToolDefinition> definitions = new ArrayList<>(loopraOrdered.size() + extOrdered.size());
        for (Tool tool : loopraOrdered) {
            definitions.add(tool.definition());
        }
        for (Tool tool : extOrdered) {
            definitions.add(tool.definition());
        }
        return definitions;
    }

    @Override
    public ToolResult call(ToolCall call, LoopContext context) {
        Tool tool = find(call.toolId())
            .orElseThrow(() -> new ToolNotFoundException("unknown tool: " + call.toolId()));
        return tool.call(call, context);
    }
}
