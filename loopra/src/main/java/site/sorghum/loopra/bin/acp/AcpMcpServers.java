package site.sorghum.loopra.bin.acp;

import com.agentclientprotocol.sdk.spec.AcpSchema.*;
import org.noear.solon.ai.mcp.client.McpServerParameters;
import site.sorghum.loopra.bin.agent.environment.ChatMode;
import site.sorghum.loopra.bin.mcp.McpProjectConfig;

import java.io.IOException;
import java.nio.file.Path;
import java.util.*;

/** Shared conversion between managed MCP definitions and ACP v1 session setup. */
public final class AcpMcpServers {
    private AcpMcpServers() {}

    public static List<McpServer> managed(Path workspace) {
        return managed(Path.of(System.getProperty("user.home"), ".loopra", McpProjectConfig.CONFIG_FILE), workspace);
    }

    public static List<McpServer> managed(Path globalConfig, Path workspace) {
        return managed(globalConfig, workspace, Map.of());
    }

    public static List<McpServer> managed(Path workspace, String agentId) {
        if (ChatMode.isChatRoot(workspace)) return List.of();
        return managed(Path.of(System.getProperty("user.home"), ".loopra", McpProjectConfig.CONFIG_FILE), workspace,
                site.sorghum.loopra.bin.mcp.AgentMcpPreferences.choices(agentId));
    }

    public static Map<String, McpServerParameters> definitions(Path globalConfig, Path workspace) throws IOException {
        Map<String, McpServerParameters> definitions = new LinkedHashMap<>(McpProjectConfig.read(globalConfig));
        // A disabled project definition also masks a global server with the same name.
        definitions.putAll(McpProjectConfig.read(McpProjectConfig.path(workspace)));
        return definitions;
    }

    private static List<McpServer> managed(Path globalConfig, Path workspace, Map<String, Boolean> choices) {
        if (ChatMode.isChatRoot(workspace)) return List.of();
        try {
            Map<String, McpServerParameters> definitions = definitions(globalConfig, workspace);
            List<McpServer> result = new ArrayList<>();
            definitions.forEach((name, parameters) -> {
                if (parameters != null && choices.getOrDefault(name, parameters.isEnabled())) result.add(toAcp(name, parameters));
            });
            return List.copyOf(result);
        } catch (IOException | RuntimeException e) {
            // Never include configuration values (environment variables / authorization headers).
            throw new IllegalStateException("无法读取 ACP MCP 配置，请检查全局及项目 mcp-servers.json");
        }
    }

    public static McpServer toAcp(String name, McpServerParameters parameters) {
        if (name == null || name.isBlank()) throw new IllegalArgumentException("MCP server name is required");
        String type = parameters.getTypeOrTransport();
        type = type == null ? (parameters.getCommand() == null ? "http" : "stdio") : type.toLowerCase(Locale.ROOT);
        return switch (type) {
            case "stdio" -> new McpServerStdio(name, required(parameters.getCommand(), name),
                    parameters.getArgs() == null ? List.of() : List.copyOf(parameters.getArgs()),
                    parameters.getEnv() == null ? List.of() : parameters.getEnv().entrySet().stream()
                            .map(e -> new EnvVariable(e.getKey(), e.getValue())).toList());
            case "http", "streamable", "streamable-http", "streamable_stateless" ->
                    new McpServerHttp(name, required(parameters.getUrl(), name), headers(parameters.getHeaders()));
            case "sse" -> new McpServerSse(name, required(parameters.getUrl(), name), headers(parameters.getHeaders()));
            default -> throw new IllegalArgumentException("Unsupported MCP transport for server: " + name);
        };
    }

    private static String required(String value, String name) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException("Incomplete MCP server: " + name);
        return value;
    }

    private static List<HttpHeader> headers(Map<String, String> headers) {
        return headers == null ? List.of() : headers.entrySet().stream()
                .map(e -> new HttpHeader(e.getKey(), e.getValue())).toList();
    }

    public static String name(McpServer server) {
        if (server instanceof McpServerStdio stdio) return stdio.name();
        if (server instanceof McpServerHttp http) return http.name();
        if (server instanceof McpServerSse sse) return sse.name();
        throw new IllegalArgumentException("Unsupported MCP server");
    }

    public static McpServerParameters fromAcp(McpServer server) {
        McpServerParameters parameters = new McpServerParameters();
        if (server instanceof McpServerStdio stdio) {
            parameters.setType("stdio");
            parameters.setCommand(required(stdio.command(), stdio.name()));
            parameters.setArgs(stdio.args() == null ? List.of() : stdio.args());
            Map<String, String> env = new LinkedHashMap<>();
            if (stdio.env() != null) stdio.env().forEach(e -> env.put(e.name(), e.value()));
            parameters.setEnv(env);
        } else {
            List<HttpHeader> headers;
            if (server instanceof McpServerHttp http) {
                parameters.setType("streamable"); parameters.setUrl(required(http.url(), http.name())); headers = http.headers();
            } else if (server instanceof McpServerSse sse) {
                parameters.setType("sse"); parameters.setUrl(required(sse.url(), sse.name())); headers = sse.headers();
            } else throw new IllegalArgumentException("Unsupported MCP server");
            Map<String, String> values = new LinkedHashMap<>();
            if (headers != null) headers.forEach(h -> values.put(h.name(), h.value()));
            parameters.setHeaders(values);
        }
        return parameters;
    }
}
