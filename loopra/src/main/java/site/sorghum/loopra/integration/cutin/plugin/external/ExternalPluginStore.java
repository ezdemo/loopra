package site.sorghum.loopra.integration.cutin.plugin.external;

import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.Feature;
import org.noear.snack4.ONode;
import org.noear.snack4.Options;
import org.noear.snack4.json.JsonWriter;
import site.sorghum.cutin.core.plugin.PluginBeanManager;
import site.sorghum.cutin.core.plugin.PluginPackageLoader;
import site.sorghum.loopra.integration.JarFiles;
import site.sorghum.loopra.integration.cutin.plugin.LoopraPluginRuntime;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;

/**
 * 外置插件仓库：管理通过 JAR 直链安装的外部插件。
 *
 * <p>安装目录为 <code>~/.loopra/plugins/</code>，安装清单持久化到
 * <code>~/.loopra/plugins/installed.json</code>；AgentLoop 启动时按清单自动加载，
 * 运行中安装/卸载会实时广播到全部存活的 AgentLoop。</p>
 *
 * <p>来源支持两种形式：</p>
 * <ul>
 *   <li>以 {@code .jar} 结尾的 HTTP(S) 直链 — 下载后入库</li>
 *   <li>本地 {@code .jar} 文件路径 — 复制后入库（适合开发调试）</li>
 * </ul>
 *
 * <p>插件 id 与版本从文件名 {@code {id}-{version}.jar} 推断，推断不出版本时记为 {@code unknown}。</p>
 */
@Slf4j
public final class ExternalPluginStore {

    /** 外置插件安装目录（位于 ~/.loopra/plugins）。 */
    private final Path pluginDirectory;
    /** 安装清单文件。 */
    private final Path manifestFile;
    private final JarFiles jarFiles;

    /** 使用默认 ~/.loopra/plugins 目录创建仓库。 */
    public ExternalPluginStore() {
        this(Paths.get(System.getProperty("user.home"), ".loopra", "plugins"));
    }

    /** 使用自定义目录创建仓库（测试用）。 */
    public ExternalPluginStore(Path pluginDirectory) {
        this.pluginDirectory = pluginDirectory;
        this.jarFiles = new JarFiles(pluginDirectory, "插件");
        this.manifestFile = pluginDirectory.resolve("installed.json");
    }

    // ==================== 数据模型 ====================

    /**
     * 已安装外置插件记录。
     *
     * @param id          插件 id（从文件名推断，用于清单管理）
     * @param version     版本（从文件名推断，推断不出为 unknown）
     * @param sourceUrl   安装来源直链或本地路径
     * @param fileName    本地 jar 文件名
     * @param sha256      安装时的文件摘要，启动加载前校验
     * @param pluginIds   jar 内实际声明的 LoopPlugin id 列表（运行时注销依据）
     * @param enabled     是否随启动加载
     * @param installedAt 安装时间戳（毫秒）
     */
    public record InstalledPlugin(
        String id,
        String version,
        String sourceUrl,
        String fileName,
        String sha256,
        List<String> pluginIds,
        boolean enabled,
        long installedAt
    ) {

        /** 兼容旧清单：pluginIds 缺失时回退到文件名推断 id。 */
        public InstalledPlugin {
            if (pluginIds == null) {
                pluginIds = List.of(id);
            }
        }
    }

    /** 清单持久化结构。 */
    private static class Manifest {
        public List<InstalledPlugin> plugins = new ArrayList<>();
    }

    // ==================== 查询 ====================

    /** 列出全部已安装外置插件（按 id 排序）。 */
    public synchronized List<InstalledPlugin> installed() {
        return loadManifest().plugins.stream()
            .sorted(Comparator.comparing(InstalledPlugin::id))
            .toList();
    }

    /** 按 id 查找已安装插件。 */
    public synchronized Optional<InstalledPlugin> find(String id) {
        return loadManifest().plugins.stream().filter(p -> p.id().equals(id)).findFirst();
    }

    // ==================== 安装 / 卸载 ====================

    /**
     * 从 JAR 直链或本地 jar 路径安装插件：获取文件、计算摘要、写入清单并热注册到全部存活 AgentLoop。
     *
     * <p>重复安装同一 id 视为更新：先移除旧版本再安装。</p>
     *
     * @param sourceUrl 以 .jar 结尾的 HTTP(S) 直链或本地 jar 文件路径
     * @return 安装记录
     */
    public synchronized InstalledPlugin install(String sourceUrl) {
        String source = requireJarSource(sourceUrl);
        String[] idAndVersion = inferIdAndVersion(source);
        if (LoopraPluginRuntime.isBuiltIn(idAndVersion[0])) {
            throw new IllegalArgumentException("插件 id 与内置插件冲突: " + idAndVersion[0]);
        }

        Manifest manifest = loadManifest();
        // 同 id 重复安装视为更新
        manifest.plugins.stream().filter(p -> p.id().equals(idAndVersion[0]))
            .forEach(old -> removeQuietly(old));

        Path jar = acquireJar(source, idAndVersion[0], idAndVersion[1]);
        // 先在本地验证可发现插件并收集实际声明 id，再落清单，避免坏包污染配置
        List<String> declaredIds = new ArrayList<>();
        try (PluginPackageLoader.LoadedPackage loaded = new PluginPackageLoader().load(jar)) {
            if (loaded.plugins().isEmpty()) {
                throw new IllegalStateException("no LoopPlugin found in jar: " + jar.getFileName());
            }
            loaded.plugins().forEach(p -> {
                declaredIds.add(p.id());
                log.info("[plugin] 发现外置插件: {} ({})", p.id(), p.getClass().getName());
            });
        } catch (IOException ignored) {
            // 验证用的加载器关闭失败不影响安装流程
        } catch (RuntimeException exception) {
            // 坏包不入库：删除已复制/下载的副本后抛出
            try {
                Files.deleteIfExists(jar);
            } catch (IOException ignored2) {
                // 清理失败不影响原始异常抛出
            }
            throw exception;
        }
        InstalledPlugin plugin = new InstalledPlugin(
            idAndVersion[0], idAndVersion[1], source,
            jar.getFileName().toString(), sha256(jar), List.copyOf(declaredIds),
            true, System.currentTimeMillis());

        manifest.plugins.removeIf(p -> p.id().equals(plugin.id()));
        manifest.plugins.add(plugin);
        saveManifest(manifest);
        int failures = LoopraPluginRuntime.registerExternalEverywhere(jar);
        if (failures > 0) {
            log.warn("[plugin] 外置插件 {} 已入清单，但 {} 个运行中实例热注册失败（新会话将正常加载）",
                plugin.id(), failures);
        }
        log.info("[plugin] 外置插件已安装: {} v{} <- {}", plugin.id(), plugin.version(), source);
        return plugin;
    }

    /**
     * 卸载插件：从全部存活 AgentLoop 注销、删除本地 jar 并更新清单。
     */
    public synchronized void uninstall(String id) {
        Manifest manifest = loadManifest();
        Optional<InstalledPlugin> target = manifest.plugins.stream()
            .filter(p -> p.id().equals(id)).findFirst();
        if (target.isEmpty()) {
            throw new IllegalArgumentException("unknown external plugin: " + id);
        }
        InstalledPlugin removed = target.get();
        for (String declaredId : removed.pluginIds()) {
            LoopraPluginRuntime.unregisterExternalEverywhere(declaredId);
        }
        removeQuietly(removed);
        manifest.plugins.removeIf(p -> p.id().equals(id));
        saveManifest(manifest);
        log.info("[plugin] 外置插件已卸载: {}", id);
    }

    /**
     * 启用/禁用外置插件：禁用时立即从全部存活 AgentLoop 注销；启用时重新热注册。
     */
    public synchronized InstalledPlugin setEnabled(String id, boolean enabled) {
        Manifest manifest = loadManifest();
        InstalledPlugin target = manifest.plugins.stream()
            .filter(p -> p.id().equals(id)).findFirst()
            .orElseThrow(() -> new IllegalArgumentException("unknown external plugin: " + id));
        if (target.enabled() == enabled) {
            return target;
        }
        InstalledPlugin updated = new InstalledPlugin(target.id(), target.version(), target.sourceUrl(),
            target.fileName(), target.sha256(), target.pluginIds(), enabled, target.installedAt());
        manifest.plugins.removeIf(p -> p.id().equals(id));
        manifest.plugins.add(updated);
        saveManifest(manifest);
        if (enabled) {
            LoopraPluginRuntime.registerExternalEverywhere(pluginDirectory.resolve(target.fileName()));
        } else {
            for (String declaredId : target.pluginIds()) {
                LoopraPluginRuntime.unregisterExternalEverywhere(declaredId);
            }
        }
        log.info("[plugin] 外置插件已{}: {}", enabled ? "启用" : "禁用", id);
        return updated;
    }

    // ==================== 启动加载 ====================

    /**
     * 把全部启用的外置插件加载进指定管理器（AgentLoop 启动时调用）。
     *
     * <p>单个插件加载失败只告警跳过，不影响宿主与其他插件。</p>
     */
    public void loadInto(PluginBeanManager manager) {
        for (InstalledPlugin plugin : installed()) {
            if (!plugin.enabled()) {
                continue;
            }
            Path jar = pluginDirectory.resolve(plugin.fileName());
            if (!Files.exists(jar)) {
                log.warn("[plugin] 外置插件 jar 缺失，跳过: {} ({})", plugin.id(), jar);
                continue;
            }
            String actual = sha256(jar);
            if (!actual.equals(plugin.sha256())) {
                log.warn("[plugin] 外置插件摘要校验失败，跳过: {} (期望 {}, 实际 {})",
                    plugin.id(), plugin.sha256(), actual);
                continue;
            }
            try {
                manager.discover(jar);
                log.info("[plugin] 外置插件已加载: {} v{}", plugin.id(), plugin.version());
            } catch (RuntimeException exception) {
                log.warn("[plugin] 外置插件加载失败，跳过: {}", plugin.id(), exception);
            }
        }
    }

    // ==================== 内部实现 ====================

    /** 校验并规范化插件来源：以 .jar 结尾的 HTTP(S) 直链或本地 jar 文件路径。 */
    private String requireJarSource(String sourceUrl) {
        return jarFiles.requireSource(sourceUrl);
    }

    /** 从来源文件名 {id}-{version}.jar 推断 id 与版本（兼容 / 与 \ 分隔符）。 */
    static String[] inferIdAndVersion(String source) {
        return JarFiles.inferIdAndVersion(source);
    }

    /** 获取插件 jar 到安装目录：URL 走下载，本地路径走复制；返回本地路径。 */
    private Path acquireJar(String source, String id, String version) {
        return jarFiles.acquire(source, id, version);
    }

    /** 删除插件 jar（含按旧命名规则可能存在的残留文件），失败仅告警。 */
    private void removeQuietly(InstalledPlugin plugin) {
        try {
            Files.deleteIfExists(pluginDirectory.resolve(plugin.fileName()));
        } catch (IOException exception) {
            log.warn("[plugin] 删除插件 jar 失败: {}", plugin.fileName(), exception);
        }
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
            log.warn("[plugin] 读取外置插件清单失败，按空清单处理: {}", manifestFile, exception);
            return new Manifest();
        }
    }

    /** 写入清单（美化格式）。 */
    private void saveManifest(Manifest manifest) {
        try {
            Files.createDirectories(pluginDirectory);
            String json = JsonWriter.write(
                ONode.ofBean(manifest),
                Options.of(Feature.Write_PrettyFormat));
            Files.writeString(manifestFile, json, StandardCharsets.UTF_8);
        } catch (IOException exception) {
            log.error("[plugin] 保存外置插件清单失败", exception);
        }
    }
}
