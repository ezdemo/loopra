package site.sorghum.loopra.bin.mcp;

import lombok.extern.slf4j.Slf4j;
import org.noear.solon.ai.chat.tool.FunctionTool;
import org.noear.solon.ai.mcp.client.McpClientProvider;
import org.noear.solon.annotation.Component;
import org.noear.solon.annotation.Inject;
import org.noear.solon.core.event.AppLoadEndEvent;
import org.noear.solon.core.event.EventListener;
import site.sorghum.loopra.bin.config.ConfigService;
import site.sorghum.loopra.tool.solon.mcp.LoopraMcpSkill;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

/**
 * MCP 服务器管理服务。
 * <p>
 * 基于 LoopraMcpSkill（McpGatewaySkill）实现 MCP 服务器的增删改查、
 * 启停控制、连接检测及工具权限管理。
 * 配置持久化到 <code>~/.loopra/mcp-servers.json</code>，服务重启后自动恢复。
 * </p>
 *
 * @author Sorghum
 */
@Slf4j
@Component
public class McpManageService implements EventListener<AppLoadEndEvent> {

    private static final String CONFIG_FILE = "mcp-servers.json";

    @Inject
    private LoopraMcpSkill loopraMcpSkill;

    @Inject
    private ConfigService configService;

    /** 内存存储：服务器名称 → 配置 */
    private final Map<String, McpServerDTO> serverStore = new ConcurrentHashMap<>();

    /**
     * 初始化：从持久化文件加载已注册的 MCP 服务器，并注册到 skill。
     */
    public void init() {
        McpPersistenceData data = loadFromFile();
        if (data != null) {
            // 恢复服务器并注册到 skill
            if (data.servers != null) {
                for (McpServerDTO server : data.servers) {
                    try {
                        if (server.enabled) registerToSkill(server);
                        serverStore.put(server.name, server);
                        log.debug("自动加载 MCP 服务器: {} (type={})", server.name, server.type);
                    } catch (Exception e) {
                        log.warn("自动加载 MCP 服务器失败: {}", server.name, e);
                    }
                }
            }
            log.info("MCP 服务器加载完成: {} 个", serverStore.size());
        }
    }

    // ==================== 服务器增删改查 ====================

    /**
     * 获取所有 MCP 服务器列表。
     */
    public List<McpServerDTO> listServers() {
        return new ArrayList<>(serverStore.values());
    }

    /**
     * 新增 MCP 服务器。
     */
    public McpServerDTO addServer(McpServerDTO server) {
        registerToSkill(server);
        serverStore.put(server.name, server);
        saveToFile();
        log.info("MCP 服务器已新增并注册: {} (type={})", server.name, server.type);
        return server;
    }

    /**
     * 更新 MCP 服务器配置（先移除旧配置，再注册新配置）。
     */
    public McpServerDTO updateServer(String originalName, McpServerDTO server) {
        // 先移除旧的
        if (originalName != null && !originalName.equals(server.name)) {
            removeMcpServerFromSkill(originalName);
            serverStore.remove(originalName);
        } else if (originalName != null) {
            removeMcpServerFromSkill(originalName);
        }

        // 注册新的
        registerToSkill(server);
        serverStore.put(server.name, server);
        saveToFile();
        log.info("MCP 服务器已更新: {} -> {}", originalName, server.name);
        return server;
    }

    /**
     * 删除 MCP 服务器。
     */
    public void removeServer(String name) {
        removeMcpServerFromSkill(name);
        serverStore.remove(name);
        saveToFile();
        log.info("MCP 服务器已删除: {}", name);
    }

    // ==================== 启停控制 ====================

    /**
     * 启用或禁用 MCP 服务器。
     */
    public McpServerDTO toggleServer(String name, boolean enabled) {
        McpServerDTO server = serverStore.get(name);
        if (server == null) return null;

        boolean previousEnabled = server.enabled;
        server.setEnabled(enabled);
        try {
            if (enabled) registerToSkill(server);
            else removeMcpServerFromSkill(name);
        } catch (RuntimeException error) {
            server.setEnabled(previousEnabled);
            throw error;
        }
        saveToFile();
        log.info("MCP 服务器 {} 已{}", name, enabled ? "启用" : "禁用");
        return server;
    }

    // ==================== 连接检测 ====================

    /**
     * 检测 MCP 服务器连接是否可达。
     */
    public boolean checkConnection(McpServerDTO server) {
        var parameters = McpProjectConfig.toParameters(server);
        parameters.setTimeout(Duration.ofSeconds(5));
        try (McpClientProvider provider = McpClientFactory.create(server.name + "-check", parameters, null)) {
            Collection<FunctionTool> tools = provider.getTools();
            log.info("MCP 服务器连接检测成功: {} (type={}, tools={})", server.name, server.type, tools.size());
            return true;
        } catch (Exception e) {
            log.warn("MCP 服务器连接检测失败: {} (type={}): {}", server.name, server.type, e.getMessage());
            return false;
        }
    }

    // ==================== 工具管理 ====================

    /**
     * 获取指定服务器的工具列表及权限状态。
     */
    public McpToolListDTO listTools(String serverName) {
        McpServerDTO server = serverStore.get(serverName);
        if (server == null) {
            return new McpToolListDTO(false, Collections.emptyList(), Collections.emptyList());
        }

        Set<String> globallyDisabled = configService.getDisabledTools();

        try {
            McpClientProvider provider = loopraMcpSkill.getMcpServer(serverName);
            if (provider == null) {
                return new McpToolListDTO(false, Collections.emptyList(), new ArrayList<>(globallyDisabled));
            }

            Collection<FunctionTool> tools = provider.getTools();
            List<McpToolInfoDTO> toolList = tools.stream()
                    .map(t -> new McpToolInfoDTO(t.name(), t.description() != null ? t.description() : ""))
                    .collect(Collectors.toList());

            return new McpToolListDTO(true, toolList, new ArrayList<>(globallyDisabled));
        } catch (Exception e) {
            log.warn("获取 MCP 服务器工具列表失败: {}", serverName, e);
            return new McpToolListDTO(false, Collections.emptyList(), new ArrayList<>(globallyDisabled));
        }
    }

    /**
     * 保存工具权限配置。
     */
    public void saveToolPermissions(String serverName, List<String> disallowedTools) {
        // 1. 先清除该服务器所有工具的旧禁用状态
        try {
            McpClientProvider provider = loopraMcpSkill.getMcpServer(serverName);
            if (provider != null) {
                List<String> serverToolNames = provider.getTools().stream()
                        .map(FunctionTool::name)
                        .collect(Collectors.toList());
                configService.removeDisabledTools(serverToolNames);
            }
        } catch (Exception e) {
            log.warn("获取 MCP 服务器工具列表失败，跳过清理: {}", e.getMessage());
        }

        // 2. 添加新禁用的工具（自动去重）
        if (disallowedTools != null && !disallowedTools.isEmpty()) {
            configService.addDisabledTools(disallowedTools);
        }

        log.info("[mcp] 工具权限已保存 (server={}), 禁用 {} 个工具", serverName,
                disallowedTools != null ? disallowedTools.size() : 0);
    }

    // ==================== 注册到 Skill ====================

    private void registerToSkill(McpServerDTO server) {
        McpClientProvider provider;
        try { provider = McpClientFactory.create(server.name, McpProjectConfig.toParameters(server), null); }
        catch (IOException error) { throw new IllegalStateException("创建 MCP 客户端失败: " + server.name, error); }
        loopraMcpSkill.addMcpServer(server.name, provider);
    }

    private void removeMcpServerFromSkill(String name) {
        try {
            loopraMcpSkill.removeMcpServer(name);
        } catch (Exception e) {
            log.warn("从 Skill 移除 MCP 服务器失败: {}", name, e);
        }
    }

    // ==================== 文件持久化 ====================

    private Path configPath() {
        return Paths.get(System.getProperty("user.home"), ".loopra", CONFIG_FILE);
    }

    private void saveToFile() {
        try {
            Path path = configPath();
            McpConfigFile.write(path, serverStore.values());
        } catch (IOException e) {
            log.error("保存 MCP 配置失败", e);
        }
    }

    private McpPersistenceData loadFromFile() {
        Path path = configPath();
        if (!Files.exists(path)) {
            return null;
        }
        try {
            McpPersistenceData data = new McpPersistenceData();
            data.servers = McpConfigFile.read(path);
            return data;
        } catch (IOException e) {
            log.warn("读取 MCP 配置失败: {}", path, e);
            return null;
        }
    }

    @Override
    public void onEvent(AppLoadEndEvent event) throws Throwable {
        init();
    }

    // ==================== 内部数据模型 ====================

    /**
     * 持久化数据结构：包含服务器列表和禁用工具配置。
     */
    public static class McpPersistenceData {
        public List<McpServerDTO> servers;
    }
}
