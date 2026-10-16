package site.sorghum.loopra.integration.cutin.plugin;

import site.sorghum.cutin.core.plugin.AgentPlugin;
import site.sorghum.cutin.core.plugin.PluginBeanManager;
import site.sorghum.cutin.core.plugin.PluginBeanManager.PluginState;
import site.sorghum.cutin.core.plugin.LoopPlugin;
import site.sorghum.cutin.core.plugin.PluginPackageLoader;
import site.sorghum.loopra.integration.cutin.plugin.compaction.LoopraCompactionPlugin;
import site.sorghum.loopra.integration.cutin.plugin.exit.LoopraExitPlugin;
import site.sorghum.loopra.integration.cutin.plugin.httplog.LoopraHttpLogPlugin;
import site.sorghum.loopra.integration.cutin.plugin.plan.LoopraPlanPlugin;
import site.sorghum.loopra.integration.cutin.plugin.policy.LoopraMessageHealingPlugin;
import site.sorghum.loopra.integration.cutin.plugin.policy.LoopraModelPolicyPlugin;
import site.sorghum.loopra.integration.cutin.plugin.policy.LoopraToolPolicyPlugin;
import site.sorghum.loopra.integration.cutin.plugin.preflight.LoopraHitlPlugin;
import site.sorghum.loopra.integration.cutin.plugin.preflight.LoopraMessageSanitizerPlugin;
import site.sorghum.loopra.integration.cutin.plugin.preflight.LoopraUserMessagePlugin;
import site.sorghum.loopra.integration.cutin.plugin.rawlog.LoopraRawLogPlugin;
import site.sorghum.loopra.integration.cutin.plugin.reasoning.LoopraReasoningStartedPlugin;
import site.sorghum.loopra.integration.cutin.plugin.recovery.LoopraErrorRecoveryPlugin;
import site.sorghum.loopra.integration.cutin.plugin.retry.LoopraRetryPolicyPlugin;
import site.sorghum.loopra.integration.cutin.plugin.session.LoopraSessionAffinityPlugin;
import site.sorghum.loopra.integration.cutin.plugin.session.LoopraSessionPlugin;
import site.sorghum.loopra.integration.cutin.plugin.state.LoopraStateNoticePlugin;
import site.sorghum.loopra.integration.cutin.plugin.toolbatch.LoopraToolBatchPlugin;
import site.sorghum.loopra.integration.cutin.plugin.usage.LoopraTokenSpeedPlugin;
import site.sorghum.loopra.integration.cutin.plugin.usage.LoopraUsagePlugin;

import java.lang.ref.WeakReference;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Loopra 进程级插件运行时：同步全部 AgentLoop 的插件启停状态。
 * 管理器使用弱引用登记，Agent 被淘汰后不会因此滞留。
 */
public final class LoopraPluginRuntime {

    private static final List<Class<? extends LoopPlugin>> BUILT_INS = List.of(
        LoopraHttpLogPlugin.class,
        LoopraRawLogPlugin.class,
        LoopraMessageSanitizerPlugin.class,
        LoopraHitlPlugin.class,
        LoopraUserMessagePlugin.class,
        LoopraUsagePlugin.class,
        LoopraTokenSpeedPlugin.class,
        LoopraSessionAffinityPlugin.class,
        LoopraCompactionPlugin.class,
        LoopraReasoningStartedPlugin.class,
        LoopraModelPolicyPlugin.class,
        LoopraMessageHealingPlugin.class,
        LoopraToolPolicyPlugin.class,
        LoopraExitPlugin.class,
        LoopraErrorRecoveryPlugin.class,
        LoopraRetryPolicyPlugin.class,
        LoopraSessionPlugin.class,
        LoopraPlanPlugin.class,
        LoopraToolBatchPlugin.class,
        LoopraStateNoticePlugin.class
    );

    private static final Map<String, Descriptor> CATALOG = new LinkedHashMap<>();
    private static final List<WeakReference<PluginBeanManager>> MANAGERS = new ArrayList<>();
    private static final Set<String> DISABLED = new LinkedHashSet<>();
    private static boolean configured;

    static {
        for (Class<? extends LoopPlugin> type : BUILT_INS) {
            declare(type);
        }
    }

    private LoopraPluginRuntime() {
    }

    /** 登记一个已启动的 AgentLoop 插件管理器，并应用当前全局策略。 */
    public static synchronized void attach(PluginBeanManager manager, Collection<String> initialDisabled) {
        if (!configured) {
            configureDisabled(initialDisabled);
        }
        catalog(manager);
        cleanupManagers();
        if (MANAGERS.stream().noneMatch(reference -> reference.get() == manager)) {
            MANAGERS.add(new WeakReference<>(manager));
        }
        for (PluginState state : manager.pluginStates()) {
            if (DISABLED.contains(state.id()) && state.active()) {
                manager.stopPlugin(state.id());
            }
        }
    }

    /** 主动解除登记；弱引用仍作为异常释放时的兜底。 */
    public static synchronized void detach(PluginBeanManager manager) {
        MANAGERS.removeIf(reference -> reference.get() == null || reference.get() == manager);
    }

    /**
     * 把外置插件 jar 热注册到全部存活的 AgentLoop。
     *
     * <p>每个管理器使用独立的类加载器实例与插件实例，互不影响；
     * 返回注册失败的 AgentLoop 数量（0 表示全部成功）。</p>
     */
    public static synchronized int registerExternalEverywhere(Path jar) {
        cleanupManagers();
        int failures = 0;
        for (PluginBeanManager manager : liveManagers()) {
            try {
                PluginPackageLoader.LoadedPackage loaded = new PluginPackageLoader().load(jar);
                for (LoopPlugin plugin : loaded.plugins()) {
                    manager.registerPlugin(plugin, loaded.classLoader());
                }
                catalog(manager);
            } catch (RuntimeException exception) {
                failures++;
            }
        }
        return failures;
    }

    /** 从全部存活的 AgentLoop 注销指定 id 的外置插件。 */
    public static synchronized void unregisterExternalEverywhere(String pluginId) {
        cleanupManagers();
        for (PluginBeanManager manager : liveManagers()) {
            boolean present = manager.pluginStates().stream()
                .anyMatch(state -> state.id().equals(pluginId));
            if (present) {
                try {
                    manager.unregisterPlugin(pluginId);
                } catch (RuntimeException ignored) {
                    // 单个实例注销失败不影响其他实例；状态可通过查询接口诊断
                }
            }
        }
    }

    /** 判断指定 id 是否为内置插件，用于外置插件安装时的冲突检测。 */
    public static synchronized boolean isBuiltIn(String pluginId) {
        for (Class<? extends LoopPlugin> type : BUILT_INS) {
            AgentPlugin annotation = type.getAnnotation(AgentPlugin.class);
            String builtInId = annotation == null ? null : annotation.id();
            if (pluginId.equals(builtInId)) {
                return true;
            }
        }
        return false;
    }

    /** 从持久化配置初始化策略；不会启动或停止尚未登记的实例。 */
    public static synchronized void configureDisabled(Collection<String> pluginIds) {
        DISABLED.clear();
        if (pluginIds != null) {
            pluginIds.stream().filter(id -> id != null && !id.isBlank()).forEach(DISABLED::add);
        }
        configured = true;
    }

    /** 查询全部内置及运行时发现插件的聚合状态。 */
    public static synchronized List<PluginView> plugins() {
        cleanupManagers();
        Map<String, int[]> instances = new LinkedHashMap<>();
        for (PluginBeanManager manager : liveManagers()) {
            catalog(manager);
            for (PluginState state : manager.pluginStates()) {
                int[] counts = instances.computeIfAbsent(state.id(), ignored -> new int[2]);
                counts[1]++;
                if (state.active()) counts[0]++;
            }
        }
        return CATALOG.values().stream()
            .sorted(Comparator.comparingInt(Descriptor::order).thenComparing(Descriptor::id))
            .map(descriptor -> {
                int[] counts = instances.getOrDefault(descriptor.id(), new int[2]);
                return new PluginView(
                    descriptor.id(),
                    descriptor.displayName(),
                    descriptor.remark(),
                    descriptor.className(),
                    descriptor.order(),
                    !DISABLED.contains(descriptor.id()),
                    counts[0],
                    counts[1]
                );
            })
            .toList();
    }

    /** 原子地把插件状态广播到全部存活 AgentLoop。 */
    public static synchronized PluginView setEnabled(String id, boolean enabled) {
        if (!CATALOG.containsKey(id)) {
            throw new IllegalArgumentException("unknown plugin: " + id);
        }
        cleanupManagers();
        List<ChangedManager> changed = new ArrayList<>();
        try {
            for (PluginBeanManager manager : liveManagers()) {
                PluginState state = state(manager, id);
                if (state == null || state.active() == enabled) continue;
                if (enabled) manager.startPlugin(id); else manager.stopPlugin(id);
                changed.add(new ChangedManager(manager, state.active()));
            }
        } catch (RuntimeException exception) {
            for (int i = changed.size() - 1; i >= 0; i--) {
                ChangedManager item = changed.get(i);
                try {
                    if (item.wasActive()) item.manager().startPlugin(id);
                    else item.manager().stopPlugin(id);
                } catch (RuntimeException ignored) {
                    // 保留原始异常；状态可通过查询接口进一步诊断。
                }
            }
            throw exception;
        }
        if (enabled) DISABLED.remove(id); else DISABLED.add(id);
        return plugins().stream().filter(plugin -> plugin.id().equals(id)).findFirst().orElseThrow();
    }

    public static synchronized Set<String> disabledPluginIds() {
        return Set.copyOf(DISABLED);
    }

    private static void declare(Class<? extends LoopPlugin> type) {
        AgentPlugin annotation = type.getAnnotation(AgentPlugin.class);
        if (annotation == null) return;
        CATALOG.put(annotation.id(), new Descriptor(
            annotation.id(), displayName(type), annotation.remark(), type.getName(), annotation.order()
        ));
    }

    private static void catalog(PluginBeanManager manager) {
        for (PluginState state : manager.pluginStates()) {
            CATALOG.putIfAbsent(state.id(), new Descriptor(
                state.id(), displayName(state.className()), "", state.className(), state.order()
            ));
        }
    }

    private static PluginState state(PluginBeanManager manager, String id) {
        return manager.pluginStates().stream().filter(plugin -> plugin.id().equals(id)).findFirst().orElse(null);
    }

    private static List<PluginBeanManager> liveManagers() {
        return MANAGERS.stream().map(WeakReference::get).filter(manager -> manager != null).toList();
    }

    private static void cleanupManagers() {
        MANAGERS.removeIf(reference -> reference.get() == null);
    }

    private static String displayName(Class<?> type) {
        return displayName(type.getSimpleName());
    }

    private static String displayName(String className) {
        String simpleName = className.substring(className.lastIndexOf('.') + 1)
            .replaceFirst("^Loopra", "")
            .replaceFirst("Plugin$", "");
        return simpleName.replaceAll("([a-z0-9])([A-Z])", "$1 $2");
    }

    private record Descriptor(String id, String displayName, String remark, String className, int order) {
    }

    private record ChangedManager(PluginBeanManager manager, boolean wasActive) {
    }

    public record PluginView(
        String id,
        String displayName,
        String remark,
        String className,
        int order,
        boolean enabled,
        int activeInstances,
        int totalInstances
    ) {
    }
}
