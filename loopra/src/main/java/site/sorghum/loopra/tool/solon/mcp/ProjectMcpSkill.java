package site.sorghum.loopra.tool.solon.mcp;

import lombok.extern.slf4j.Slf4j;
import org.noear.solon.ai.chat.tool.FunctionTool;
import org.noear.solon.ai.mcp.client.McpClientProvider;
import org.noear.solon.ai.mcp.client.McpServerParameters;
import site.sorghum.loopra.bin.mcp.McpProjectConfig;
import site.sorghum.loopra.bin.mcp.McpClientFactory;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 绑定到一个项目根目录的 MCP 网关。
 *
 * <p>该类不注册到 Solon IoC。每个项目由 {@code LoopraSkillProvider} 创建并缓存
 * 一个实例，因此项目 MCP 不会进入全局 {@link LoopraMcpSkill}。</p>
 */
@Slf4j
public final class ProjectMcpSkill extends LoopraMcpSkill implements AutoCloseable {

    private static final long MAX_CONFIG_BYTES = 8L * 1024 * 1024;

    private final Path configPath;
    private final Map<String, McpServerParameters> definitions = new LinkedHashMap<>();
    private final Map<String, McpClientProvider> ownedProviders = new LinkedHashMap<>();
    private final Map<String, String> loadErrors = new LinkedHashMap<>();
    private boolean closed;

    private ProjectMcpSkill(Path configPath) {
        this.configPath = configPath.toAbsolutePath().normalize();
    }

    /**
     * 从项目配置创建 MCP 网关。
     *
     * @return 配置不存在、为空或无法加载时返回 {@code null}
     */
    public static ProjectMcpSkill load(Path workspace) {
        Path configPath = McpProjectConfig.path(workspace);
        if (configPath == null || !Files.isRegularFile(configPath)) {
            return null;
        }
        try {
            long size = Files.size(configPath);
            if (size > MAX_CONFIG_BYTES) {
                log.warn("[mcp-project] 跳过过大的项目 MCP 配置: {} ({} bytes)", configPath, size);
                return null;
            }
        } catch (IOException e) {
            log.warn("[mcp-project] 无法检查项目 MCP 配置: {} - {}", configPath, e.getMessage());
            return null;
        }

        ProjectMcpSkill skill = new ProjectMcpSkill(configPath);
        try {
            Map<String, McpServerParameters> definitions = McpProjectConfig.read(configPath);
            skill.definitions.putAll(definitions);
            for (Map.Entry<String, McpServerParameters> entry : definitions.entrySet()) {
                McpServerParameters parameters = entry.getValue();
                if (parameters == null || !parameters.isEnabled()) {
                    continue;
                }
                McpClientProvider provider = null;
                try {
                    provider = McpClientFactory.create(entry.getKey(), parameters, workspace);
                    skill.addMcpServer(entry.getKey(), provider);
                    skill.ownedProviders.put(entry.getKey(), provider);
                    log.debug("[mcp-project] 加载项目 MCP: {} ({})", entry.getKey(), configPath);
                } catch (Exception e) {
                    if (provider != null) {
                        try {
                            provider.close();
                        } catch (Exception ignored) {
                            // provider 关闭失败不影响原始异常传播
                        }
                    }
                    log.warn("[mcp-project] 加载项目 MCP 服务器失败: {} - {}", entry.getKey(), e.getMessage());
                    skill.loadErrors.put(entry.getKey(), messageOf(e));
                }
            }
            if (skill.definitions.isEmpty()) {
                skill.close();
                return null;
            }
            log.info("[mcp-project] 项目 MCP 加载完成: {} 个启用服务器 / {} 个配置项, projectConfig={}",
                    skill.ownedProviders.size(), skill.definitions.size(), configPath);
            return skill;
        } catch (Exception e) {
            skill.close();
            log.warn("[mcp-project] 读取项目 MCP 配置失败: {} - {}", configPath, e.getMessage());
            return null;
        }
    }

    /** 项目 MCP 配置文件路径，供日志和外部诊断使用。 */
    public Path configPath() {
        return configPath;
    }

    /** 当前网关已注册的项目 MCP 服务器数量。 */
    public int serverCount() {
        return ownedProviders.size();
    }

    /**
     * 返回供项目能力面板使用的服务器摘要，不暴露敏感连接配置。
     */
    public synchronized List<ServerInfo> serverInfos() {
        List<ServerInfo> result = new ArrayList<>();
        for (Map.Entry<String, McpServerParameters> entry : definitions.entrySet()) {
            String name = entry.getKey();
            McpServerParameters parameters = entry.getValue();
            McpClientProvider provider = ownedProviders.get(name);
            List<String> toolNames = new ArrayList<>();
            String error = loadErrors.get(name);
            if (provider != null) {
                try {
                    Collection<FunctionTool> tools = provider.getTools();
                    if (tools != null) {
                        for (FunctionTool tool : tools) {
                            if (tool != null && tool.name() != null) {
                                toolNames.add(tool.name());
                            }
                        }
                    }
                } catch (Exception e) {
                    error = messageOf(e);
                }
            }
            result.add(new ServerInfo(
                    name,
                    parameters == null ? "" : parameters.getTypeOrTransport(),
                    parameters != null && parameters.isEnabled(),
                    provider != null,
                    toolNames.size(),
                    List.copyOf(toolNames),
                    error
            ));
        }
        return List.copyOf(result);
    }

    private static String messageOf(Exception error) {
        String message = error == null ? null : error.getMessage();
        return message == null || message.isBlank() ? "加载失败" : message;
    }

    /** MCP 服务器的安全展示摘要。 */
    public record ServerInfo(
            String name,
            String type,
            boolean enabled,
            boolean loaded,
            int toolCount,
            List<String> toolNames,
            String error
    ) {
    }

    /** 关闭该项目独占的 MCP 客户端及其本地进程。 */
    @Override
    public synchronized void close() {
        if (closed) {
            return;
        }
        for (String name : new ArrayList<>(ownedProviders.keySet())) {
            try {
                removeMcpServer(name);
            } catch (Exception e) {
                log.debug("[mcp-project] 关闭项目 MCP 失败: {} - {}", name, e.getMessage());
            }
        }
        ownedProviders.clear();
        closed = true;
    }
}
