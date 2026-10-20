package site.sorghum.loopra.bin.mcp;

import org.noear.snack4.ONode;
import org.noear.solon.ai.mcp.client.McpClientProviders;
import org.noear.solon.ai.mcp.client.McpServerParameters;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * 项目级 MCP 配置读取器。
 *
 * <p>项目配置放在项目根目录的 {@code .loopra/mcp-servers.json}，不会写入
 * 或修改用户级 {@code ~/.loopra/mcp-servers.json}。读取器同时兼容标准的
 * {@code mcpServers} 对象格式和 Loopra 管理页当前使用的 {@code servers} 数组格式。</p>
 */
public final class McpProjectConfig {

    public static final String CONFIG_FILE = "mcp-servers.json";

    private McpProjectConfig() {
    }

    /** 返回指定项目的项目级 MCP 配置路径。 */
    public static Path path(Path workspace) {
        if (workspace == null) {
            return null;
        }
        return workspace.toAbsolutePath().normalize()
                .resolve(".loopra")
                .resolve(CONFIG_FILE);
    }

    /**
     * 读取 MCP 配置。
     *
     * @return 按配置文件顺序排列的服务器定义；文件不存在时返回空 Map
     */
    public static Map<String, McpServerParameters> read(Path configPath) throws IOException {
        if (configPath == null || !Files.isRegularFile(configPath)) {
            return Map.of();
        }

        String json = Files.readString(configPath, StandardCharsets.UTF_8);
        ONode root = ONode.ofJson(json);

        // Both sections may coexist when a library such as Magpie manages mcpServers.
        // Standard entries take precedence on collisions without hiding other native servers.
        if (root.getOrNull("servers") != null || root.getOrNull("mcpServers") != null) {
            Map<String, McpServerParameters> result = new LinkedHashMap<>();
            for (McpServerDTO server : McpConfigFile.read(root)) {
                result.put(server.name, toParameters(server));
            }
            return result;
        }

        // 也接受没有 mcpServers 包装层的标准服务器对象映射。
        return new LinkedHashMap<>(McpClientProviders.parseMcpServers(root));
    }

    public static McpServerParameters toParameters(McpServerDTO server) {
        McpServerParameters parameters = new McpServerParameters();
        parameters.setType(normalizeType(server.type, server.url, server.command));
        parameters.setEnabled(server.enabled);
        if (server.url != null && !server.url.isBlank()) {
            parameters.setUrl(server.url);
        }
        if (server.command != null && !server.command.isBlank()) {
            parameters.setCommand(server.command);
        }
        if (server.args != null) {
            parameters.setArgs(new ArrayList<>(server.args));
        }
        if (server.env != null) {
            parameters.setEnv(new LinkedHashMap<>(server.env));
        }
        if (server.headers != null) {
            parameters.setHeaders(new LinkedHashMap<>(server.headers));
        }
        Duration timeout = parseTimeout(server.timeout);
        if (timeout != null) {
            parameters.setTimeout(timeout);
        }
        return parameters;
    }

    private static String normalizeType(String type, String url, String command) {
        String normalized = type == null ? "" : type.trim().toLowerCase(Locale.ROOT);
        if (normalized.isBlank()) {
            return url != null && !url.isBlank() && (command == null || command.isBlank())
                    ? "streamable"
                    : "stdio";
        }
        return switch (normalized) {
            case "http", "streamable-http" -> "streamable";
            default -> normalized;
        };
    }

    private static Duration parseTimeout(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        String normalized = value.trim().toLowerCase(Locale.ROOT);
        try {
            if (normalized.endsWith("ms")) {
                return Duration.ofMillis(Long.parseLong(normalized.substring(0, normalized.length() - 2)));
            }
            if (normalized.endsWith("s")) {
                return Duration.ofSeconds(Long.parseLong(normalized.substring(0, normalized.length() - 1)));
            }
            if (normalized.endsWith("m")) {
                return Duration.ofMinutes(Long.parseLong(normalized.substring(0, normalized.length() - 1)));
            }
            if (normalized.matches("\\d+")) {
                return Duration.ofSeconds(Long.parseLong(normalized));
            }
            return Duration.parse(value.startsWith("PT") ? value : "PT" + value);
        } catch (RuntimeException ignored) {
            return null;
        }
    }

}
