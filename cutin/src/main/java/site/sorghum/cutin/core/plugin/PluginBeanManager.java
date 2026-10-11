package site.sorghum.cutin.core.plugin;

import site.sorghum.cutin.core.event.EventHandler;
import site.sorghum.cutin.core.event.Hook;
import site.sorghum.cutin.core.loop.InterceptPoint;
import site.sorghum.cutin.core.loop.LoopInterceptor;
import site.sorghum.cutin.core.model.ModelProvider;
import site.sorghum.cutin.core.tool.Tool;
import site.sorghum.cutin.core.tool.ToolProvider;

import java.io.IOException;
import java.lang.reflect.InvocationTargetException;
import java.net.URLClassLoader;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/** 插件 Bean 与生命周期管理器。 */
public final class PluginBeanManager implements PluginContext {
    private final LoopRegistrar registrar;
    private final Map<String, Object> beansById = new HashMap<>();
    private final Map<Class<?>, Object> beansByType = new HashMap<>();
    private final Map<String, Object> ordinaryBeans = new HashMap<>();
    private final List<PluginEntry> plugins = new ArrayList<>();
    /** 外置插件类加载器引用计数：归零时关闭，避免影响共享同一 jar 的其他插件。 */
    private final Map<URLClassLoader, Integer> loaderRefs = new IdentityHashMap<>();
    private boolean started;

    public PluginBeanManager(LoopRegistrar registrar) {
        this.registrar = Objects.requireNonNull(registrar, "registrar");
    }

    public void registerPlugin(Class<? extends LoopPlugin> pluginClass) {
        try {
            registerPlugin(pluginClass.getDeclaredConstructor().newInstance());
        } catch (NoSuchMethodException | InstantiationException | IllegalAccessException
                 | InvocationTargetException exception) {
            throw new IllegalStateException("plugin must have a public no-arg constructor: " + pluginClass, exception);
        }
    }

    public synchronized void registerPlugin(LoopPlugin plugin) {
        registerPlugin(plugin, null);
    }

    /**
     * 注册外置插件并绑定其类加载器。
     *
     * <p>卸载时若加载器不再被其他插件引用则一并关闭。</p>
     */
    public synchronized void registerPlugin(LoopPlugin plugin, URLClassLoader loader) {
        Objects.requireNonNull(plugin, "plugin");
        String id = pluginId(plugin);
        if (beansById.containsKey(id)) {
            throw new IllegalStateException("duplicate plugin id: " + id);
        }
        AgentPlugin annotation = plugin.getClass().getAnnotation(AgentPlugin.class);
        PluginEntry entry = new PluginEntry(annotation == null ? 0 : annotation.order(), id, plugin, loader);
        plugins.add(entry);
        retainLoader(loader);
        rebuildBeans();
        if (started) {
            startEntry(entry);
        }
    }

    /** 从指定路径发现外置插件包并注册；类加载器由管理器持有，卸载时释放。 */
    public void discover(Path pluginPackage) {
        PluginPackageLoader.LoadedPackage loaded = new PluginPackageLoader().load(pluginPackage);
        for (LoopPlugin plugin : loaded.plugins()) {
            registerPlugin(plugin, loaded.classLoader());
        }
    }

    public synchronized void registerBean(Object bean) {
        registerBean(bean.getClass().getSimpleName(), bean);
    }

    public synchronized void registerBean(String id, Object bean) {
        ordinaryBeans.put(id, bean);
        rebuildBeans();
    }

    /** 按 order 启动尚未启动的插件。 */
    public synchronized void startAll() {
        if (started) {
            return;
        }
        started = true;
        List<PluginEntry> sorted = plugins.stream()
            .sorted(Comparator.comparingInt(PluginEntry::order))
            .toList();
        try {
            for (PluginEntry entry : sorted) {
                startEntry(entry);
            }
        } catch (RuntimeException exception) {
            started = false;
            stopAllEntries();
            throw exception;
        }
    }

    /** 停止全部插件并释放插件注册的扩展。 */
    public synchronized void stopAll() {
        stopAllEntries();
        started = false;
    }

    /** 按 id 启动单个插件；管理器必须已经启动。 */
    public synchronized void startPlugin(String id) {
        if (!started) {
            throw new IllegalStateException("plugin manager is not started");
        }
        findEntry(id).ifPresentOrElse(this::startEntry,
            () -> { throw new IllegalArgumentException("unknown plugin: " + id); });
    }

    /** 按 id 停止单个插件并释放其扩展。 */
    public synchronized void stopPlugin(String id) {
        findEntry(id).ifPresentOrElse(this::stopEntry,
            () -> { throw new IllegalArgumentException("unknown plugin: " + id); });
    }

    /** 移除插件实例；移除前会先停止并释放全部扩展与类加载器。 */
    public synchronized void unregisterPlugin(String id) {
        PluginEntry entry = findEntry(id).orElseThrow(() -> new IllegalArgumentException("unknown plugin: " + id));
        stopEntry(entry);
        plugins.remove(entry);
        releaseLoader(entry.loader);
        rebuildBeans();
    }

    /** 返回当前管理器内全部插件的只读运行状态。 */
    public synchronized List<PluginState> pluginStates() {
        return plugins.stream()
            .sorted(Comparator.comparingInt(PluginEntry::order).thenComparing(entry -> entry.id))
            .map(entry -> new PluginState(
                entry.id,
                entry.plugin.getClass().getName(),
                entry.order,
                entry.active
            ))
            .toList();
    }

    /** 单个插件实例的通用运行状态，不包含宿主产品语义。 */
    public record PluginState(String id, String className, int order, boolean active) {
    }

    @Override
    @SuppressWarnings("unchecked")
    public synchronized <T> T getBean(Class<T> type) {
        Object bean = beansByType.get(type);
        if (bean == null) {
            throw new IllegalStateException("no plugin bean of type: " + type);
        }
        return (T) bean;
    }

    @Override
    @SuppressWarnings("unchecked")
    public synchronized <T> T getBean(String name) {
        Object bean = beansById.get(name);
        if (bean == null) {
            throw new IllegalStateException("no plugin bean named: " + name);
        }
        return (T) bean;
    }

    private void startEntry(PluginEntry entry) {
        if (entry.active) {
            return;
        }
        entry.registrations.clear();
        try {
            entry.plugin.configure(this);
            entry.plugin.register(new TrackingLoopRegistrar(registrar, entry.registrations));
            entry.plugin.start();
            entry.active = true;
        } catch (RuntimeException exception) {
            closeRegistrations(entry);
            throw exception;
        }
    }

    private void stopEntry(PluginEntry entry) {
        if (!entry.active && entry.registrations.isEmpty()) {
            return;
        }
        try {
            entry.plugin.stop();
        } finally {
            closeRegistrations(entry);
            entry.active = false;
        }
    }

    private void stopAllEntries() {
        for (int i = plugins.size() - 1; i >= 0; i--) {
            stopEntry(plugins.get(i));
        }
    }

    private void closeRegistrations(PluginEntry entry) {
        for (int i = entry.registrations.size() - 1; i >= 0; i--) {
            entry.registrations.get(i).close();
        }
        entry.registrations.clear();
    }

    private java.util.Optional<PluginEntry> findEntry(String id) {
        return plugins.stream().filter(entry -> entry.id.equals(id)).findFirst();
    }

    private String pluginId(LoopPlugin plugin) {
        AgentPlugin annotation = plugin.getClass().getAnnotation(AgentPlugin.class);
        return annotation == null ? plugin.id() : annotation.id();
    }

    private void rebuildBeans() {
        beansById.clear();
        beansByType.clear();
        ordinaryBeans.forEach(this::indexBean);
        plugins.forEach(entry -> indexBean(entry.id, entry.plugin));
    }

    private void indexBean(String id, Object bean) {
        beansById.put(id, bean);
        beansByType.put(bean.getClass(), bean);
        for (Class<?> type : bean.getClass().getInterfaces()) {
            beansByType.putIfAbsent(type, bean);
        }
    }

    /** 登记类加载器引用。 */
    private void retainLoader(URLClassLoader loader) {
        if (loader != null) {
            loaderRefs.merge(loader, 1, Integer::sum);
        }
    }

    /** 释放类加载器引用；归零时关闭以真正卸载外置插件类。 */
    private void releaseLoader(URLClassLoader loader) {
        if (loader == null) {
            return;
        }
        Integer count = loaderRefs.get(loader);
        if (count == null) {
            return;
        }
        if (count <= 1) {
            loaderRefs.remove(loader);
            try {
                loader.close();
            } catch (IOException ignored) {
                // 关闭失败不影响卸载流程；未关闭的加载器会随 GC 回收
            }
        } else {
            loaderRefs.put(loader, count - 1);
        }
    }

    private static final class PluginEntry {
        private final int order;
        private final String id;
        private final LoopPlugin plugin;
        /** 外置插件的类加载器；内置插件为 null。 */
        private final URLClassLoader loader;
        private final List<Registration> registrations = new ArrayList<>();
        private boolean active;

        private PluginEntry(int order, String id, LoopPlugin plugin, URLClassLoader loader) {
            this.order = order;
            this.id = id;
            this.plugin = plugin;
            this.loader = loader;
        }

        int order() { return order; }
    }

    private static final class TrackingLoopRegistrar implements LoopRegistrar {
        private final LoopRegistrar delegate;
        private final List<Registration> registrations;

        private TrackingLoopRegistrar(LoopRegistrar delegate, List<Registration> registrations) {
            this.delegate = delegate;
            this.registrations = registrations;
        }

        private Registration track(Registration registration) {
            registrations.add(registration);
            return registration;
        }

        @Override public void addInterceptor(InterceptPoint point, int order, LoopInterceptor interceptor) {
            delegate.addInterceptor(point, order, interceptor);
        }
        @Override public void addTool(Tool tool) { delegate.addTool(tool); }
        @Override public void addToolProvider(ToolProvider provider) { delegate.addToolProvider(provider); }
        @Override public void addModelProvider(ModelProvider provider) { delegate.addModelProvider(provider); }
        @Override public void addEventHandler(EventHandler handler) { delegate.addEventHandler(handler); }
        @Override public void addHook(Hook hook) { delegate.addHook(hook); }

        @Override public Registration registerInterceptor(InterceptPoint point, int order, LoopInterceptor interceptor) {
            return track(delegate.registerInterceptor(point, order, interceptor));
        }
        @Override public Registration registerTool(Tool tool) { return track(delegate.registerTool(tool)); }
        @Override public Registration registerToolProvider(ToolProvider provider) { return track(delegate.registerToolProvider(provider)); }
        @Override public Registration registerModelProvider(ModelProvider provider) { return track(delegate.registerModelProvider(provider)); }
        @Override public Registration registerEventHandler(EventHandler handler) { return track(delegate.registerEventHandler(handler)); }
        @Override public Registration registerHook(Hook hook) { return track(delegate.registerHook(hook)); }
    }
}
