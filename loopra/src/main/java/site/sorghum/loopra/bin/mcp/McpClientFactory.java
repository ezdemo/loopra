package site.sorghum.loopra.bin.mcp;

import io.modelcontextprotocol.client.McpAsyncClient;
import io.modelcontextprotocol.client.McpClient;
import io.modelcontextprotocol.client.transport.ServerParameters;
import io.modelcontextprotocol.client.transport.StdioClientTransport;
import io.modelcontextprotocol.json.McpJsonDefaults;
import io.modelcontextprotocol.spec.McpSchema;
import io.modelcontextprotocol.spec.McpTransportException;
import io.modelcontextprotocol.spec.ProtocolVersions;
import org.noear.solon.ai.mcp.client.McpClientProperties;
import org.noear.solon.ai.mcp.client.McpClientProvider;
import org.noear.solon.ai.mcp.client.McpClientProviders;
import org.noear.solon.ai.mcp.client.McpServerParameters;
import reactor.core.publisher.Mono;

import java.io.IOException;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/** Shared MCP creation for management, project skills and ACP sessions. */
public final class McpClientFactory {
    private McpClientFactory() {}

    // Solon 4.1.1's schema understands these revisions, but its stdio transport
    // inherits McpTransport's 2024-only default. Keep negotiation strict while
    // advertising the supported revisions, as the HTTP transport already does.
    private static final List<String> STDIO_VERSIONS = List.of(
            ProtocolVersions.MCP_2024_11_05, ProtocolVersions.MCP_2025_03_26,
            ProtocolVersions.MCP_2025_06_18, ProtocolVersions.MCP_2025_11_25);

    public static StdioClientTransport stdioTransport(McpServerParameters parameters, Path cwd) {
        return new StdioClientTransport(ServerParameters.builder(parameters.getCommand())
                .args(parameters.getArgs() == null ? List.of() : parameters.getArgs())
                .env(parameters.getEnv() == null ? Map.of() : parameters.getEnv()).build(), McpJsonDefaults.getMapper()) {
            @Override public List<String> protocolVersions() { return STDIO_VERSIONS; }
            @Override protected ProcessBuilder getProcessBuilder() {
                ProcessBuilder builder = super.getProcessBuilder();
                if (cwd != null) builder.directory(cwd.toFile());
                return builder;
            }
        };
    }

    public static McpClientProvider create(String name, McpServerParameters parameters, Path cwd) throws IOException {
        String type = parameters.getTypeOrTransport();
        McpClientProvider provider = type == null || type.isBlank() || "stdio".equalsIgnoreCase(type)
                ? new StdioProvider(name, parameters, cwd) : McpClientProviders.fromMcpServer(parameters);
        provider.setEnabled(parameters.isEnabled());
        provider.setAllowedTools(parameters.getAllowedTools());
        provider.setDisallowedTools(parameters.getDisallowedTools());
        return provider;
    }

    /** Solon exposes no transport factory hook. Retain its tool/resource/prompt
     * conversion and permissions, supplying only the stdio client lifecycle here. */
    private static final class StdioProvider extends McpClientProvider {
        private final McpClientProperties properties;
        private final McpServerParameters parameters;
        private final Path cwd;
        private McpAsyncClient client;
        private boolean closed;
        private McpSchema.LoggingLevel loggingLevel = McpSchema.LoggingLevel.INFO;

        StdioProvider(String name, McpServerParameters parameters, Path cwd) {
            this(properties(name, parameters), parameters, cwd);
        }

        private StdioProvider(McpClientProperties properties, McpServerParameters parameters, Path cwd) {
            super(properties);
            this.properties = properties;
            this.parameters = parameters;
            this.cwd = cwd;
        }

        private static McpClientProperties properties(String name, McpServerParameters parameters) {
            var properties = new McpClientProperties();
            properties.setName(name);
            properties.setChannel("stdio");
            properties.setCommand(parameters.getCommand());
            properties.setHeartbeatInterval(null);
            if (parameters.getTimeout() != null) properties.setTimeout(parameters.getTimeout());
            return properties;
        }

        @Override public synchronized McpAsyncClient getClient() {
            if (closed) throw new IllegalStateException("MCP client is closed");
            if (client == null) {
                client = McpClient.async(stdioTransport(parameters, cwd))
                        .clientInfo(new McpSchema.Implementation(properties.getName(), properties.getVersion()))
                        .requestTimeout(properties.getRequestTimeout())
                        .initializationTimeout(properties.getInitializationTimeout())
                        .toolsChangeConsumer(ignored -> invalidateCache())
                        .resourcesChangeConsumer(ignored -> invalidateCache())
                        .resourcesUpdateConsumer(ignored -> invalidateCache())
                        .promptsChangeConsumer(ignored -> invalidateCache()).build();
                try {
                    client.initialize().block();
                    if (client.getServerCapabilities().logging() != null) client.setLoggingLevel(loggingLevel).block();
                } catch (RuntimeException error) {
                    resetClient();
                    throw error;
                }
            }
            return client;
        }

        private Mono<Void> invalidateCache() {
            return Mono.fromRunnable(this::clearCache);
        }

        @Override public <T> T executeWithRetry(Function<McpAsyncClient, Mono<T>> action) {
            try { return action.apply(getClient()).block(); }
            catch (RuntimeException error) {
                if (!(error instanceof McpTransportException) && !error.toString().contains("TimeoutException")) throw error;
                synchronized (this) { resetClient(); }
                return action.apply(getClient()).block();
            }
        }

        @Override public synchronized void setLoggingLevel(McpSchema.LoggingLevel level) {
            if (level != null) loggingLevel = level;
        }

        private void resetClient() {
            var previous = client;
            client = null;
            clearCache();
            if (previous != null) {
                try { previous.closeGracefully().block(java.time.Duration.ofSeconds(5)); }
                catch (RuntimeException error) { previous.close(); }
            }
        }

        @Override public synchronized void close() {
            closed = true;
            try { resetClient(); }
            finally { super.close(); }
        }

        @Override public synchronized void reopen() {
            closed = false;
            getClient();
        }
    }
}
