package site.sorghum.loopra.bin.lsp;

import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.Feature;
import org.noear.snack4.ONode;
import org.noear.snack4.Options;
import org.noear.snack4.json.JsonWriter;
import org.noear.solon.ai.talents.lsp.LspManager;
import org.noear.solon.ai.talents.lsp.LspServerParameters;
import org.noear.solon.annotation.Component;
import org.noear.solon.annotation.Init;
import org.noear.solon.annotation.Inject;
import site.sorghum.loopra.tool.solon.lsp.SharedLoopraLspSkill;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

/**
 * LSP 服务器管理服务。
 * <p>
 * 负责 LSP 服务器的增删改查、启停控制、安装检测，
 * 以及系统内置 13 种语言 LSP 服务器的注册。
 * 配置持久化到 <code>~/.loopra/lsp-servers.json</code>，服务重启后自动恢复。
 * </p>
 *
 * @author Sorghum
 */
@Slf4j
@Component
public class LspManageService {

    private static final String CONFIG_FILE = "lsp-servers.json";

    @Inject(required = false)
    private SharedLoopraLspSkill sharedLoopraLspSkill;

    /** 内存存储：服务器名称 → 配置 */
    private final Map<String, LspServerConfig> serverStore = new ConcurrentHashMap<>();

    /** 系统内置服务器名称集合（不可删除） */
    private final Set<String> systemServerNames = new HashSet<>();

    /**
     * 初始化：加载持久化配置 + 注册系统内置 13 种语言 LSP 服务器（默认禁用）。
     */
    @Init
    public void init() {
        // 1. 先注册系统内置服务器
        List<LspServerConfig> builtinServers = BuiltinLspServers.createBuiltinServers();
        for (LspServerConfig builtin : builtinServers) {
            systemServerNames.add(builtin.getName());
            serverStore.put(builtin.getName(), builtin);
            log.debug("注册内置 LSP 服务器: {} (extensions={})", builtin.getName(), builtin.getExtensions());
        }

        // 2. 从持久化文件加载用户配置（覆盖同名内置配置，补充用户自定义）
        LspPersistenceData data = loadFromFile();
        if (data != null && data.servers != null) {
            for (LspServerConfig server : data.servers) {
                // 用户已配置的服务器覆盖内置默认配置
                serverStore.put(server.getName(), server);
                log.debug("加载持久化 LSP 服务器: {} (enabled={})", server.getName(), server.isEnabled());
            }
        }

        // 3. 对已启用的服务器执行安装检测
        for (LspServerConfig server : serverStore.values()) {
            if (server.isEnabled()) {
                boolean installed = checkInstallation(server);
                server.setInstalled(installed);
                if (installed) {
                    log.info("LSP 服务器 {} 已安装并可用", server.getName());
                    bridgeToTalent(server);
                } else {
                    log.warn("LSP 服务器 {} 已启用但命令未找到: {}", server.getName(), server.getCommand());
                }
            }
        }

        log.info("LSP 服务器加载完成: 共 {} 个（内置 {} 个）", serverStore.size(), systemServerNames.size());
    }

    // ==================== 服务器增删改查 ====================

    /**
     * 获取所有 LSP 服务器列表。
     */
    public List<LspServerConfig> listServers() {
        List<LspServerConfig> servers = new ArrayList<>(serverStore.values());
        servers.sort(Comparator.comparing(LspServerConfig::getName));
        return servers;
    }

    /**
     * 新增 LSP 服务器。
     *
     * @param server 服务器配置
     * @return 新增的服务器配置
     */
    public LspServerConfig addServer(LspServerConfig server) {
        server.setScope("user");  // 强制全局作用域
        serverStore.put(server.getName(), server);
        saveToFile();
        // 桥接到 LSP 执行层
        if (server.isEnabled()) {
            bridgeToTalent(server);
        }
        log.info("LSP 服务器已新增: {} (command={})", server.getName(), server.getCommand());
        return server;
    }

    /**
     * 更新 LSP 服务器配置（支持改名）。
     *
     * @param originalName 原名称（用于查找；若改名则用于定位旧条目）
     * @param server       新配置
     * @return 更新后的服务器配置
     */
    public LspServerConfig updateServer(String originalName, LspServerConfig server) {
        server.setScope("user");  // 强制全局作用域
        // 如果改名了，先解除旧桥接
        if (originalName != null && !originalName.equals(server.getName())) {
            unbridgeFromTalent(originalName);
            serverStore.remove(originalName);
            if (systemServerNames.contains(originalName)) {
                systemServerNames.remove(originalName);
                systemServerNames.add(server.getName());
            }
        } else if (originalName != null) {
            // 同名字更新，先解除旧桥接
            unbridgeFromTalent(originalName);
        }

        serverStore.put(server.getName(), server);
        saveToFile();
        // 桥接到 LSP 执行层
        if (server.isEnabled()) {
            bridgeToTalent(server);
        }
        log.info("LSP 服务器已更新: {} -> {}", originalName, server.getName());
        return server;
    }

    /**
     * 删除 LSP 服务器。
     * <p>系统内置服务器不允许删除。</p>
     *
     * @param name 服务器名称
     */
    public void removeServer(String name) {
        if (systemServerNames.contains(name)) {
            log.warn("尝试删除系统内置 LSP 服务器被拒绝: {}", name);
            throw new IllegalArgumentException("系统内置服务器不可删除: " + name);
        }
        // 解除 LSP 执行层桥接
        unbridgeFromTalent(name);
        serverStore.remove(name);
        saveToFile();
        log.info("LSP 服务器已删除: {}", name);
    }

    // ==================== 启停控制 ====================

    /**
     * 启用或禁用 LSP 服务器。
     *
     * @param name    服务器名称
     * @param enabled 是否启用
     * @return 更新后的配置，未找到返回 null
     */
    public LspServerConfig toggleServer(String name, boolean enabled) {
        LspServerConfig server = serverStore.get(name);
        if (server == null) {
            return null;
        }

        server.setEnabled(enabled);

        if (enabled) {
            boolean installed = checkInstallation(server);
            server.setInstalled(installed);
            if (installed) {
                log.info("LSP 服务器 {} 已启用", name);
                bridgeToTalent(server);
            } else {
                log.warn("LSP 服务器 {} 已启用但命令未找到: {}", name, server.getCommand());
            }
        } else {
            server.setInstalled(false);
            log.info("LSP 服务器 {} 已禁用", name);
            unbridgeFromTalent(name);
        }

        saveToFile();
        return server;
    }

    // ==================== 安装检测 ====================

    /**
     * 检测 LSP 服务器的命令是否在系统 PATH 中可找到。
     * <p>使用 {@code which}（Unix）/ {@code where}（Windows）检测。</p>
     *
     * @param server 服务器配置
     * @return 如果命令可执行则返回 true
     */
    public boolean checkInstallation(LspServerConfig server) {
        if (server.getCommand() == null || server.getCommand().isEmpty()) {
            return false;
        }
        String executable = server.getCommand().get(0);
        return isCommandAvailable(executable);
    }

    /**
     * 检查指定命令是否在系统 PATH 中可用。
     */
    private boolean isCommandAvailable(String command) {
        try {
            String os = System.getProperty("os.name", "").toLowerCase();
            String[] cmd;
            if (os.contains("win")) {
                cmd = new String[]{"where", command};
            } else {
                cmd = new String[]{"which", command};
            }
            Process process = new ProcessBuilder(cmd)
                    .redirectErrorStream(true)
                    .start();
            int exitCode = process.waitFor();
            return exitCode == 0;
        } catch (Exception e) {
            log.debug("命令检测异常: {} - {}", command, e.getMessage());
            return false;
        }
    }

    // ==================== 根据文件匹配 LSP 服务器 ====================

    /**
     * 根据文件路径查找匹配的已启用 LSP 服务器。
     *
     * @param filePath 文件路径
     * @return 匹配的服务器列表（按扩展名匹配）
     */
    public List<LspServerConfig> findServersForFile(String filePath) {
        return serverStore.values().stream()
                .filter(LspServerConfig::isEnabled)
                .filter(s -> s.matchesExtension(filePath))
                .collect(Collectors.toList());
    }

    // ==================== 与 LSP 执行层桥接 ====================

    /**
     * 将 LspServerConfig 转换为 LspServerParameters 并注册到 LspTalent。
     * <p>此方法是配置管理层与工具执行层之间的关键桥接点。</p>
     */
    private void bridgeToTalent(LspServerConfig config) {
        if (sharedLoopraLspSkill == null) {
            log.debug("LoopraLspSkill 未注入，跳过桥接: {}", config.getName());
            return;
        }
        try {
            LspManager lspManager = sharedLoopraLspSkill.getLspManager();
            LspServerParameters params = toLspServerParameters(config);
            lspManager.registerServer(config.getName(), params);
            log.debug("LSP 服务器已桥接到执行层: {}", config.getName());
        } catch (Exception e) {
            log.warn("桥接 LSP 服务器失败: {} - {}", config.getName(), e.getMessage());
        }
    }

    /**
     * 从 LspTalent 中移除 LSP 服务器配置。
     */
    private void unbridgeFromTalent(String serverName) {
        if (sharedLoopraLspSkill == null) {
            log.debug("LoopraLspSkill 未注入，跳过解除桥接: {}", serverName);
            return;
        }
        try {
            sharedLoopraLspSkill.getLspManager().unregisterServer(serverName);
            log.debug("LSP 服务器已从执行层解除: {}", serverName);
        } catch (Exception e) {
            log.warn("解除 LSP 服务器桥接失败: {} - {}", serverName, e.getMessage());
        }
    }

    /**
     * 将 LspServerConfig 转换为 Solon 的 LspServerParameters（执行层使用的配置类型）。
     * <p>注意：Solon 版 LspServerParameters 无 name 字段，name 作为 registerServer 的 key 传入。</p>
     */
    private LspServerParameters toLspServerParameters(LspServerConfig config) {
        LspServerParameters params = new LspServerParameters();
        params.setCommand(config.getCommand() != null ? config.getCommand() : new ArrayList<>());
        params.setExtensions(config.getExtensions() != null ? config.getExtensions() : new ArrayList<>());
        params.setEnabled(config.isEnabled());
        params.setEnv(config.getEnv() != null ? new HashMap<>(config.getEnv()) : new HashMap<>());
        // Solon 版字段名为 initialization（非 initializationOptions）
        params.setInitialization(config.getInitializationOptions() != null
                ? new HashMap<>(config.getInitializationOptions()) : new HashMap<>());
        return params;
    }

    // ==================== 文件持久化 ====================

    private Path configPath() {
        return Paths.get(System.getProperty("user.home"), ".loopra", CONFIG_FILE);
    }

    private void saveToFile() {
        try {
            Path path = configPath();
            Files.createDirectories(path.getParent());

            // 仅持久化非系统内置或已被用户修改过的服务器
            LspPersistenceData data = new LspPersistenceData();
            data.servers = new ArrayList<>();
            for (LspServerConfig server : serverStore.values()) {
                // 所有用户当前配置均持久化
                data.servers.add(server);
            }

            String json = JsonWriter.write(
                    ONode.ofBean(data),
                    Options.of(Feature.Write_PrettyFormat));
            Files.writeString(path, json, StandardCharsets.UTF_8);
        } catch (IOException e) {
            log.error("保存 LSP 配置失败", e);
        }
    }

    private LspPersistenceData loadFromFile() {
        Path path = configPath();
        if (!Files.exists(path)) {
            return null;
        }
        try {
            String json = Files.readString(path, StandardCharsets.UTF_8);
            return ONode.ofJson(json).toBean(LspPersistenceData.class);
        } catch (IOException e) {
            log.warn("读取 LSP 配置失败: {}", path, e);
            return null;
        }
    }

    /**
     * 判断指定名称是否为系统内置服务器。
     */
    public boolean isSystemServer(String name) {
        return systemServerNames.contains(name);
    }

    // ==================== 内部数据模型 ====================

    /**
     * 持久化数据结构：包含服务器列表。
     */
    public static class LspPersistenceData {
        public List<LspServerConfig> servers;
    }
}
