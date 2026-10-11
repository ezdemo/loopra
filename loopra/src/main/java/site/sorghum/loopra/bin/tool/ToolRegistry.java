package site.sorghum.loopra.bin.tool;

import lombok.Getter;
import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.ONode;
import org.noear.solon.ai.chat.tool.FunctionTool;
import site.sorghum.loopra.bin.agent.environment.SessionEnvironment;
import site.sorghum.loopra.bin.agent.spi.ToolPolicyProvider;
import site.sorghum.loopra.integration.cutin.CutinFunctionToolBridge;
import site.sorghum.loopra.integration.cutin.CutinToolRegistryView;

import java.nio.file.Path;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * 工具注册表 —— 管理工具定义的注册和查询。
 * <p>
 * 职责：工具注册、查询、生成 OpenAI function-calling 格式的工具列表。
 * </p>
 *
 * @author Sorghum
 */
@Slf4j
public class ToolRegistry {

    private final LinkedHashMap<String, FunctionTool> functionToolMap = new LinkedHashMap<>();

    /** 所有扫描到的工具（包括禁用的），用于前端展示 */
    private final LinkedHashMap<String, FunctionTool> allScannedTools = new LinkedHashMap<>();

    /** cutin 引擎看到的动态工具视图，随本注册表热刷新。 */
    private final CutinToolRegistryView cutinRegistry = createCutinView();

    private CutinToolRegistryView createCutinView() {
        CutinToolRegistryView view = new CutinToolRegistryView();
        // 外部注册区（拓展包/插件工具）变更时失效 OpenAI tools 缓存
        view.setOnChange(() -> cachedOpenAiTools = null);
        return view;
    }

    /** 缓存的 OpenAI tools 格式（refresh 时失效） */
    private ONode cachedOpenAiTools = null;

    /** 静态快照（setDisabledTools 方式设置时使用，兼容 CLI/测试） */
    private Set<String> disabledToolsSnapshot = Collections.emptySet();
    /** true=使用静态快照，false=使用 ToolPolicyProvider 实时读取 */
    private boolean useSnapshot = false;

    /** 工具启用策略提供者（由上层注入，替代对 ConfigService 的直接依赖）；可为 null。 */
    @Getter
    private ToolPolicyProvider toolPolicyProvider;

    /**
     * 设置工具启用策略提供者（禁用工具 + 只读覆盖的实时来源）。
     */
    public ToolRegistry setToolPolicyProvider(ToolPolicyProvider toolPolicyProvider) {
        this.toolPolicyProvider = toolPolicyProvider;
        return this;
    }

    /**
     * 强制禁止的工具名集合 — 独立于用户配置的 disabledTools。
     * 由子代理等场景设置，用于在注册表层面硬性排除某些工具（如禁止递归 spawn）。
     * register() 和 refresh() 都会检查此集合。
     */
    @Getter
    private Set<String> forceDenyTools = Collections.emptySet();

    /**
     * 强制允许的工具名称集合。非 null 时只有集合内的工具可被注册和调用。
     * 用于探索、审查等只读子代理，避免仅靠提示词约束写操作。
     */
    @Getter
    private Set<String> forceAllowTools = null;

    // ==================== 动态刷新上下文 ====================
    @Getter
    private SessionEnvironment environment;

    /**
     * 设置被禁用的工具名称集合（静态快照，用于 CLI 模式 / 测试）。
     */
    public ToolRegistry setDisabledTools(Set<String> disabledTools) {
        this.disabledToolsSnapshot = disabledTools != null ? new HashSet<>(disabledTools) : Collections.emptySet();
        this.useSnapshot = true;
        return this;
    }

    /**
     * 获取当前生效的禁用工具列表。
     * 快照模式优先；否则回退到 ToolPolicyProvider 实时读取，未注入时用快照。
     */
    private Set<String> getCurrentDisabledTools() {
        if (!useSnapshot && toolPolicyProvider != null) {
            return toolPolicyProvider.disabledTools();
        }
        return disabledToolsSnapshot;
    }

    /**
     * 当前生效禁用工具集合的副本（供 {@code AgentLoop} 判断 tool-gateway 是否需要重启）。
     */
    public Set<String> currentDisabledTools() {
        return new HashSet<>(getCurrentDisabledTools());
    }

    /**
     * 设置强制禁止的工具名称集合。
     * 与 {@link #setDisabledTools} 不同，此集合不由用户配置控制，
     * 而是由代码逻辑（如子代理）硬性指定，独立于用户配置始终生效。
     *
     * @param denyTools 强制禁止的工具名称集合，传 null 视为空集
     */
    public void setForceDenyTools(Set<String> denyTools) {
        this.forceDenyTools = denyTools != null ? new HashSet<>(denyTools) : Collections.emptySet();
        applyForceToolFilters();
    }

    /**
     * 设置强制允许的工具名称集合。传 null 表示不限制；空集合表示不允许任何工具。
     */
    public void setForceAllowTools(Set<String> allowTools) {
        this.forceAllowTools = allowTools != null ? new HashSet<>(allowTools) : null;
        applyForceToolFilters();
    }

    private void applyForceToolFilters() {
        functionToolMap.entrySet().removeIf(entry -> !isForceAllowed(entry.getKey())
                || forceDenyTools.contains(entry.getKey()));
        cachedOpenAiTools = null;
        syncCutinRegistry();
    }

    private boolean isForceAllowed(String toolName) {
        return forceAllowTools == null || forceAllowTools.contains(toolName);
    }

    /** 设置工具扫描与执行使用的会话环境。 */
    public void setEnvironment(SessionEnvironment environment) {
        this.environment = environment;
    }

    /**
     * 清空全部工具（含 cutin 视图）——Tool 网关插件禁用时调用，实现“下线全部工具”。
     * <p>
     * 注意：cutin 视图分 loopra 同步区与外部注册区（拓展包桥接、插件贡献的
     * 工具），外部注册工具不随 {@link #syncCutinRegistry()} 清除，因此网关
     * 禁用时必须以 clearTools 整体清空 legacy 与 cutin 视图（含外部注册区）。
     * </p>
     */
    public synchronized void clearTools() {
        functionToolMap.clear();
        allScannedTools.clear();
        cachedOpenAiTools = null;
        cutinRegistry.clearAll();
    }

    /**
      * 动态刷新工具列表 —— 插件化后仅在 gateway 禁用时保留旧扫描路径，
      * 正常路径由 {@code LoopraToolGatewayPlugin} 通过 cutin 注入，
      * 此处仅同步只读覆盖与禁用过滤，避免旧拼接重新渗入 prompt。
      */
    public synchronized void refresh() {
        Set<String> disabled = getCurrentDisabledTools();
        Map<String, Boolean> readOnlyOverrides = toolPolicyProvider != null
                ? toolPolicyProvider.toolReadOnlyOverrides()
                : Collections.emptyMap();
        // 若已通过 cutin 注入（由 gateway 持有），refresh 仍需刷新 legacy 的只读覆盖与禁用过滤，
        // 但不重新扫描避免与 gateway 竞争；仅对已存在工具重新应用过滤
        if (!allScannedTools.isEmpty() || !functionToolMap.isEmpty()) {
            // 重新应用只读覆盖与禁用过滤到现有集合
            Map<String, FunctionTool> snapshot = new LinkedHashMap<>(allScannedTools);
            functionToolMap.clear();
            allScannedTools.clear();
            cachedOpenAiTools = null;
            for (FunctionTool tool : snapshot.values()) {
                ToolMetadata.applyReadOnlyOverride(tool, readOnlyOverrides.get(tool.name()));
                register(tool, disabled);
            }
            syncCutinRegistry();
            return;
        }
        functionToolMap.clear();
        allScannedTools.clear();
        cachedOpenAiTools = null;
        List<FunctionTool> functionToolsList = ToolScanUtil.scanTools(
                environment == null ? null : environment.executionRoot());
        for (FunctionTool tool : functionToolsList) {
            ToolMetadata.applyReadOnlyOverride(tool, readOnlyOverrides.get(tool.name()));
            register(tool, disabled);
        }
        syncCutinRegistry();
    }

    /**
      * 注册函数工具，并应用与 refresh() 相同的启用规则。
     */
    public void register(FunctionTool tool) {
        register(tool, getCurrentDisabledTools());
        syncCutinRegistry();
    }

    private void register(FunctionTool tool, Set<String> disabled) {
        Objects.requireNonNull(tool, "tool");
        FunctionTool existing = allScannedTools.putIfAbsent(tool.name(), tool);
        if (existing != null && existing != tool) {
            log.warn("[tool] 忽略同名工具注册: name={}, existing={}, duplicate={}",
                    tool.name(), existing.getClass().getName(), tool.getClass().getName());
            return;
        }
        if (!disabled.contains(tool.name()) && !forceDenyTools.contains(tool.name())
                && isForceAllowed(tool.name())) {
            functionToolMap.putIfAbsent(tool.name(), tool);
        }
        cachedOpenAiTools = null;
    }

    public FunctionTool get(String name) {
        return functionToolMap.getOrDefault(name, null);
    }

    public boolean has(String name) {
        return functionToolMap.containsKey(name);
    }

    /**
     * 复制当前注册表的全部配置及工具列表到新实例。
     * <p>
     * 继承父级的所有设置：configService、disabledTools、
     * 会话环境以及全部已注册的工具。
     * 调用方可在返回后自行调用 {@link #setForceDenyTools} 设置强制禁止名单。
     * </p>
     *
     * @return 新的 ToolRegistry 实例，包含全部配置和工具
     */
    public ToolRegistry copy() {
        ToolRegistry copy = new ToolRegistry();
        // 复制禁用工具快照
        copy.disabledToolsSnapshot = this.disabledToolsSnapshot.isEmpty()
                ? Collections.emptySet()
                : new HashSet<>(this.disabledToolsSnapshot);
        copy.useSnapshot = this.useSnapshot;
        copy.forceDenyTools = this.forceDenyTools.isEmpty()
                ? Collections.emptySet()
                : new HashSet<>(this.forceDenyTools);
        copy.forceAllowTools = this.forceAllowTools == null ? null : new HashSet<>(this.forceAllowTools);
        // 复制工具策略提供者（实时禁用/只读来源）
        copy.toolPolicyProvider = this.toolPolicyProvider;
        // 复制会话环境
        copy.environment = this.environment;
        // 注册所有工具
        for (FunctionTool def : this.functionToolMap.values()) {
            copy.functionToolMap.put(def.name(), def);
        }
        for (FunctionTool def : this.allScannedTools.values()) {
            copy.allScannedTools.put(def.name(), def);
        }
        copy.syncCutinRegistry();
        return copy;
    }

    /**
     * 返回所有已启用工具的不可变视图。
     */
    public Map<String, FunctionTool> all() {
        return Collections.unmodifiableMap(functionToolMap);
    }

    /**
     * 返回所有扫描到的工具（包括已禁用的）的不可变视图。
     */
    public Map<String, FunctionTool> allScanned() {
        return Collections.unmodifiableMap(allScannedTools);
    }

    /**
     * 判断指定工具当前是否已启用。
     *
     * @param toolName 工具名称
     * @return true 表示已启用，false 表示已禁用
     */
    public boolean isEnabled(String toolName) {
        Set<String> disabled = getCurrentDisabledTools();
        return !disabled.contains(toolName) && !forceDenyTools.contains(toolName)
                && isForceAllowed(toolName);
    }

    /**
     * 生成 OpenAI 格式的 tools 数组（带缓存，refresh 时自动失效）。
     */
    public ONode toOpenAiTools() {
        if (cachedOpenAiTools != null) {
            return cachedOpenAiTools;
        }
        List<FunctionTool> functionTools = functionToolMap.values().stream().toList();
        ONode tools = new ONode();
        for (FunctionTool func : functionTools) {
            tools.addNew().then(n2 -> {
                n2.set("type", "function");
                n2.getOrNew("function").then(toolNode -> {
                    toolNode.set("name", func.name());
                    toolNode.set("description", func.descriptionAndMeta());
                    toolNode.set("parameters", ONode.ofJson(
                            ONode.serialize(ToolSchemaSanitizer.sanitize(func.inputSchema()))));
                });
            });
        }
        // 合并外部注册区（拓展包桥接、插件贡献）工具，模型同样可见可调用。
        // loopra 工具已由 functionToolMap 生成；gateway 插件会以 CutinFunctionToolBridge
        // 镜像注册进视图外部区，同 id 者跳过避免重复声明。
        for (site.sorghum.cutin.core.tool.Tool ext : cutinRegistry.externalTools()) {
            if (functionToolMap.containsKey(ext.id())) {
                continue;
            }
            site.sorghum.cutin.core.tool.ToolDefinition def = ext.definition();
            tools.addNew().then(n2 -> {
                n2.set("type", "function");
                n2.getOrNew("function").then(toolNode -> {
                    toolNode.set("name", def.id());
                    toolNode.set("description", def.description());
                    toolNode.set("parameters", ONode.ofJson(ONode.serialize(def.inputSchema())));
                });
            });
        }
        cachedOpenAiTools = tools;
        return tools;
    }

    /**
     * cutin 引擎使用的动态工具视图。
     * <p>
     * Loopra 的 {@code register}/{@code refresh}/{@code setForceDenyTools} 等变更
     * 都会同步到该视图，因此 cutin 引擎可以在不重建的情况下看到最新工具列表。
     * </p>
     */
    public CutinToolRegistryView cutinRegistry() {
        return cutinRegistry;
    }

    private void syncCutinRegistry() {
        cutinRegistry.setTools(
            functionToolMap.values().stream()
                .map(CutinFunctionToolBridge::new)
                .toList()
        );
    }
}
