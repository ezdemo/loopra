package site.sorghum.loopra.integration.extpack;

import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.Feature;
import org.noear.snack4.ONode;
import org.noear.snack4.Options;
import org.noear.snack4.json.JsonWriter;
import org.noear.solon.hotplug.PluginPackage;
import site.sorghum.loopra.integration.JarFiles;

import java.io.IOException;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.ServiceLoader;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 拓展包仓库：管理通过 JAR 直链安装的 Solon H-SPI 拓展包。
 *
 * <p>安装目录为 <code>~/.loopra/extpacks/</code>，安装清单持久化到
 * <code>~/.loopra/extpacks/extpacks.json</code>；主程序启动时按清单
 * 自动启动启用的拓展包，运行中安装/启停实时生效并同步到全部存活
 * AgentLoop（经由 {@link LoopraExtPackRuntime}）。</p>
 *
 * <p>与 cutin 外置插件（{@code ExternalPluginStore}）的区别：拓展包是
 * 进程级单例（自带 Solon 容器/配置/依赖），一个 jar 一份；其贡献的
 * Agent 能力通过 jar 内 {@code META-INF/services/...LoopraExtPackBridge}
 * 声明的桥接实现接入引擎。</p>
 */
@Slf4j
public final class ExtPackStore {

    /** 拓展包安装目录（位于 ~/.loopra/extpacks）。 */
    private final Path extPackDirectory;
    /** 安装清单文件。 */
    private final Path manifestFile;
    private final JarFiles jarFiles;
    /** 运行态：id → 已加载/启动的包。 */
    private final Map<String, RunningPack> running = new ConcurrentHashMap<>();

    /** 使用默认 ~/.loopra/extpacks 目录创建仓库。 */
    public ExtPackStore() {
        this(Paths.get(System.getProperty("user.home"), ".loopra", "extpacks"));
    }

    /** 使用自定义目录创建仓库（测试用）。 */
    public ExtPackStore(Path extPackDirectory) {
        this.extPackDirectory = extPackDirectory;
        this.jarFiles = new JarFiles(extPackDirectory, "拓展包");
        this.manifestFile = extPackDirectory.resolve("extpacks.json");
    }

    // ==================== 数据模型 ====================

    /**
     * 已安装拓展包记录。
     *
     * @param id            拓展包 id（从文件名推断，用于清单管理）
     * @param version       版本（从文件名推断，推断不出为 unknown）
     * @param sourceUrl     安装来源直链或本地路径
     * @param fileName      本地 jar 文件名
     * @param sha256        安装时的文件摘要，启动加载前校验
     * @param bridgeClasses jar 内声明的 LoopraExtPackBridge 实现类名（启动时实例化依据）
     * @param enabled       是否随启动加载
     * @param installedAt   安装时间戳（毫秒）
     */
    public record InstalledExtPack(
        String id,
        String version,
        String sourceUrl,
        String fileName,
        String sha256,
        List<String> bridgeClasses,
        boolean enabled,
        long installedAt
    ) {
    }

    /** 拓展包运行视图（含启动状态）。 */
    public record ExtPackView(
        String id,
        String version,
        String sourceUrl,
        String fileName,
        List<String> bridgeClasses,
        boolean enabled,
        boolean started,
        int bridgeCount,
        long installedAt
    ) {
    }

    /** 清单持久化结构。 */
    private static class Manifest {
        public List<InstalledExtPack> extPacks = new ArrayList<>();
    }

    /** 运行态：已加载的 PluginPackage 与发现的桥接实例。 */
    private static final class RunningPack {
        private final PluginPackage pluginPackage;
        private final List<LoopraExtPackBridge> bridges;

        private RunningPack(PluginPackage pluginPackage, List<LoopraExtPackBridge> bridges) {
            this.pluginPackage = pluginPackage;
            this.bridges = bridges;
        }
    }

    // ==================== 查询 ====================

    /** 列出全部已安装拓展包（按 id 排序，含启动状态）。 */
    public synchronized List<ExtPackView> list() {
        return loadManifest().extPacks.stream()
            .sorted(Comparator.comparing(InstalledExtPack::id))
            .map(this::toView)
            .toList();
    }

    /** 按 id 查找已安装拓展包。 */
    public synchronized Optional<InstalledExtPack> find(String id) {
        return loadManifest().extPacks.stream().filter(p -> p.id().equals(id)).findFirst();
    }

    private ExtPackView toView(InstalledExtPack pack) {
        RunningPack run = running.get(pack.id());
        return new ExtPackView(
            pack.id(), pack.version(), pack.sourceUrl(), pack.fileName(),
            pack.bridgeClasses(), pack.enabled(),
            run != null, run == null ? 0 : run.bridges.size(), pack.installedAt());
    }

    // ==================== 安装 / 卸载 ====================

    /**
     * 从 JAR 直链或本地 jar 路径安装拓展包：获取文件、计算摘要、
     * 验证可发现桥接实现、写入清单并启动。
     *
     * <p>重复安装同一 id 视为更新：先停旧版本再安装。</p>
     *
     * @param sourceUrl 以 .jar 结尾的 HTTP(S) 直链或本地 jar 文件路径
     * @return 安装记录
     */
    public synchronized InstalledExtPack install(String sourceUrl) {
        String source = requireJarSource(sourceUrl);
        String[] idAndVersion = inferIdAndVersion(source);

        Manifest manifest = loadManifest();
        // 同 id 重复安装视为更新：先停止并移除旧版本
        manifest.extPacks.stream().filter(p -> p.id().equals(idAndVersion[0]))
            .forEach(old -> removeQuietly(old, true));

        Path jar = acquireJar(source, idAndVersion[0], idAndVersion[1]);
        // 先验证 jar 可发现桥接实现，再落清单，避免坏包污染配置
        List<String> bridgeClasses = new ArrayList<>();
        try (URLClassLoader loader = new URLClassLoader(
                new URL[]{jar.toUri().toURL()}, ExtPackStore.class.getClassLoader())) {
            ServiceLoader.load(LoopraExtPackBridge.class, loader).forEach(bridge -> {
                bridgeClasses.add(bridge.getClass().getName());
                log.info("[extpack] 发现桥接实现: {} ({})", bridge.id(), bridge.getClass().getName());
            });
            if (bridgeClasses.isEmpty()) {
                throw new IllegalStateException("jar 内未发现 LoopraExtPackBridge 实现: " + jar.getFileName());
            }
        } catch (IOException ignored) {
            // 验证用加载器关闭失败不影响安装流程
        } catch (RuntimeException exception) {
            // 坏包不入库：删除已复制/下载的副本后抛出
            try {
                Files.deleteIfExists(jar);
            } catch (IOException ignored) {
                // 清理失败不影响原始异常抛出
            }
            throw exception;
        }

        InstalledExtPack pack = new InstalledExtPack(
            idAndVersion[0], idAndVersion[1], source,
            jar.getFileName().toString(), sha256(jar), List.copyOf(bridgeClasses),
            true, System.currentTimeMillis());

        manifest.extPacks.removeIf(p -> p.id().equals(pack.id()));
        manifest.extPacks.add(pack);
        saveManifest(manifest);
        start(pack.id());
        log.info("[extpack] 拓展包已安装并启动: {} v{} <- {}", pack.id(), pack.version(), source);
        return pack;
    }

    /**
     * 卸载拓展包：先停止（含从全部 AgentLoop 注销扩展）、删除本地 jar 并更新清单。
     */
    public synchronized void uninstall(String id) {
        InstalledExtPack pack = find(id).orElseThrow(() -> new IllegalArgumentException("unknown extpack: " + id));
        removeQuietly(pack, true);
        Manifest manifest = loadManifest();
        manifest.extPacks.removeIf(p -> p.id().equals(id));
        saveManifest(manifest);
        log.info("[extpack] 拓展包已卸载: {}", id);
    }

    // ==================== 启停 ====================

    /** 按清单加载并启动全部启用的拓展包（主程序启动时调用）。 */
    public synchronized void loadAll() {
        for (InstalledExtPack pack : loadManifest().extPacks) {
            if (!pack.enabled() || running.containsKey(pack.id())) {
                continue;
            }
            try {
                start(pack.id());
            } catch (RuntimeException exception) {
                log.warn("[extpack] 拓展包启动失败，跳过: {}", pack.id(), exception);
            }
        }
    }

    /**
     * 启动拓展包：加载 jar、启动 Solon 容器、实例化桥接并注册到全部存活 AgentLoop。
     */
    public synchronized void start(String id) {
        if (running.containsKey(id)) {
            return;
        }
        InstalledExtPack pack = find(id).orElseThrow(() -> new IllegalArgumentException("unknown extpack: " + id));
        Path jar = extPackDirectory.resolve(pack.fileName());
        if (!Files.exists(jar)) {
            throw new IllegalStateException("拓展包 jar 缺失: " + jar);
        }
        String actual = sha256(jar);
        if (!actual.equals(pack.sha256())) {
            throw new IllegalStateException("拓展包摘要校验失败: " + id);
        }

        PluginPackage pkg = PluginPackage.loadJar(jar.toFile());
        try {
            pkg.start();
        } catch (RuntimeException exception) {
            PluginPackage.unloadJar(pkg);
            throw exception;
        }
        // 从包类加载器发现桥接实现（Solon Plugin 生命周期已启动）
        List<LoopraExtPackBridge> bridges = new ArrayList<>();
        ServiceLoader.load(LoopraExtPackBridge.class, pkg.getClassLoader())
            .forEach(bridges::add);
        for (LoopraExtPackBridge bridge : bridges) {
            LoopraExtPackRuntime.registerBridgeEverywhere(bridge.id(), bridge);
        }
        running.put(id, new RunningPack(pkg, bridges));
        log.info("[extpack] 拓展包已启动: {} (桥接 {} 个)", id, bridges.size());
    }

    /**
     * 停止拓展包：先从全部 AgentLoop 注销扩展，再停止并卸载 Solon 容器。
     */
    public synchronized void stop(String id) {
        RunningPack run = running.remove(id);
        if (run == null) {
            return;
        }
        for (LoopraExtPackBridge bridge : run.bridges) {
            LoopraExtPackRuntime.unregisterBridgeEverywhere(bridge.id());
        }
        try {
            run.pluginPackage.preStop();
            run.pluginPackage.stop();
        } finally {
            PluginPackage.unloadJar(run.pluginPackage);
        }
        log.info("[extpack] 拓展包已停止: {}", id);
    }

    /** 启用/停用拓展包：启用立即启动；停用立即停止（文件保留）。 */
    public synchronized InstalledExtPack setEnabled(String id, boolean enabled) {
        InstalledExtPack pack = find(id).orElseThrow(() -> new IllegalArgumentException("unknown extpack: " + id));
        if (enabled) {
            start(id);
        } else {
            stop(id);
        }
        InstalledExtPack updated = new InstalledExtPack(
            pack.id(), pack.version(), pack.sourceUrl(), pack.fileName(),
            pack.sha256(), pack.bridgeClasses(), enabled, pack.installedAt());
        Manifest manifest = loadManifest();
        manifest.extPacks.removeIf(p -> p.id().equals(id));
        manifest.extPacks.add(updated);
        saveManifest(manifest);
        return updated;
    }

    // ==================== 内部实现 ====================

    /** 停止（如运行中）并删除 jar。 */
    private void removeQuietly(InstalledExtPack pack, boolean stopFirst) {
        if (stopFirst) {
            stop(pack.id());
        }
        try {
            Files.deleteIfExists(extPackDirectory.resolve(pack.fileName()));
        } catch (IOException exception) {
            log.warn("[extpack] 删除拓展包 jar 失败: {}", pack.fileName(), exception);
        }
    }

    /** 校验并规范化拓展包来源：以 .jar 结尾的 HTTP(S) 直链或本地 jar 文件路径。 */
    private String requireJarSource(String sourceUrl) {
        return jarFiles.requireSource(sourceUrl);
    }

    /** 从来源文件名 {id}-{version}.jar 推断 id 与版本（兼容 / 与 \ 分隔符）。 */
    static String[] inferIdAndVersion(String source) {
        return JarFiles.inferIdAndVersion(source);
    }

    /** 获取拓展包 jar 到安装目录：URL 走下载，本地路径走复制；返回本地路径。 */
    private Path acquireJar(String source, String id, String version) {
        return jarFiles.acquire(source, id, version);
    }

    /** 计算文件 SHA-256 摘要（十六进制小写）。 */
    static String sha256(Path file) {
        return JarFiles.sha256(file);
    }

    /** 读取清单；文件缺失或损坏时返回空清单。 */
    private Manifest loadManifest() {
        if (!Files.exists(manifestFile)) {
            return new Manifest();
        }
        try {
            String json = Files.readString(manifestFile, StandardCharsets.UTF_8);
            Manifest manifest = ONode.ofJson(json).toBean(Manifest.class);
            return manifest != null ? manifest : new Manifest();
        } catch (IOException | RuntimeException exception) {
            log.warn("[extpack] 读取拓展包清单失败，按空清单处理: {}", manifestFile, exception);
            return new Manifest();
        }
    }

    /** 写入清单（美化格式）。 */
    private void saveManifest(Manifest manifest) {
        try {
            Files.createDirectories(extPackDirectory);
            String json = JsonWriter.write(
                ONode.ofBean(manifest),
                Options.of(Feature.Write_PrettyFormat));
            Files.writeString(manifestFile, json, StandardCharsets.UTF_8);
        } catch (IOException exception) {
            log.error("[extpack] 保存拓展包清单失败", exception);
        }
    }

    /** 内部下载器（与 ExternalPluginStore 同款：文件名安全化）。 */
}
