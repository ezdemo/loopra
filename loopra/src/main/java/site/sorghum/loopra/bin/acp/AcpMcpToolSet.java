package site.sorghum.loopra.bin.acp;

import com.agentclientprotocol.sdk.spec.AcpSchema.McpServer;
import com.agentclientprotocol.sdk.spec.AcpSchema.McpServerStdio;
import io.modelcontextprotocol.client.McpClient;
import io.modelcontextprotocol.client.McpSyncClient;
import io.modelcontextprotocol.client.transport.ServerParameters;
import io.modelcontextprotocol.client.transport.StdioClientTransport;
import io.modelcontextprotocol.json.McpJsonDefaults;
import io.modelcontextprotocol.spec.McpSchema;
import org.noear.snack4.ONode;
import org.noear.solon.ai.chat.content.*;
import org.noear.solon.ai.chat.tool.*;
import org.noear.solon.ai.mcp.client.McpClientProvider;
import org.noear.solon.ai.mcp.client.McpClientProviders;
import site.sorghum.loopra.tool.solon.mcp.McpFunctionTool;

import java.nio.file.Path;
import java.time.Duration;
import java.util.*;

/** A session owns these MCP clients; none are installed in the global skill pool. */
public final class AcpMcpToolSet implements AutoCloseable {
    private final List<AutoCloseable> clients = new ArrayList<>();
    private final List<FunctionTool> tools = new ArrayList<>();
    private final List<McpServer> servers;

    public AcpMcpToolSet(List<McpServer> servers, Path cwd) {
        this.servers = servers == null ? List.of() : List.copyOf(servers);
        Set<String> names = new HashSet<>();
        // Validate all definitions before starting any process.
        for (McpServer server : this.servers) {
            String name = AcpMcpServers.name(server);
            if (name == null || name.isBlank() || !names.add(name)) throw new IllegalArgumentException("Invalid or duplicate MCP server name");
            AcpMcpServers.fromAcp(server);
        }
        try {
            for (McpServer server : this.servers) {
                if (server instanceof McpServerStdio stdio) loadStdio(stdio, cwd);
                else {
                    McpClientProvider provider = McpClientProviders.fromMcpServer(AcpMcpServers.fromAcp(server));
                    clients.add(provider);
                    for (FunctionTool tool : provider.getToolsActivated()) tools.add(new McpFunctionTool(tool));
                }
            }
        } catch (Exception error) {
            close();
            throw new IllegalStateException("ACP MCP 连接失败，请检查服务器配置");
        }
    }

    private void loadStdio(McpServerStdio server, Path cwd) {
        var parameters = AcpMcpServers.fromAcp(server);
        // Solon's provider cannot set cwd; use the SDK transport's supported hook.
        var transport = new StdioClientTransport(ServerParameters.builder(server.command())
                .args(parameters.getArgs()).env(parameters.getEnv()).build(), McpJsonDefaults.getMapper()) {
            @Override protected ProcessBuilder getProcessBuilder() {
                ProcessBuilder builder = super.getProcessBuilder();
                if (cwd != null) builder.directory(cwd.toFile());
                return builder;
            }
        };
        transport.setStdErrorHandler(line -> {});
        McpSyncClient client = McpClient.sync(transport).requestTimeout(Duration.ofSeconds(30)).build();
        clients.add(() -> { if (!client.closeGracefully()) client.close(); });
        client.initialize();
        String cursor = null;
        do {
            var page = client.listTools(cursor);
            for (McpSchema.Tool tool : page.tools()) {
                FunctionToolDesc function = new FunctionToolDesc(tool.name());
                function.title(tool.title());
                function.description(tool.description());
                function.inputSchema(ONode.serialize(tool.inputSchema()));
                if (tool.outputSchema() != null) function.outputSchema(ONode.serialize(tool.outputSchema()));
                if (tool.meta() != null) function.meta().putAll(tool.meta());
                function.doHandle(args -> result(client.callTool(new McpSchema.CallToolRequest(tool.name(), args))));
                tools.add(new McpFunctionTool(function));
            }
            cursor = page.nextCursor();
        } while (cursor != null && !cursor.isBlank());
    }

    private static ToolResult result(McpSchema.CallToolResult source) {
        ToolResult result = new ToolResult();
        result.setError(Boolean.TRUE.equals(source.isError()));
        if (source.content() != null) for (McpSchema.Content content : source.content()) {
            if (content instanceof McpSchema.TextContent text) result.addBlock(TextBlock.of(text.text()));
            else if (content instanceof McpSchema.ImageContent image) result.addBlock(ImageBlock.ofBase64(image.data(), image.mimeType()));
            else if (content instanceof McpSchema.AudioContent audio) result.addBlock(AudioBlock.ofBase64(audio.data(), audio.mimeType()));
            else result.addBlock(TextBlock.of(ONode.serialize(content)));
        }
        if (source.meta() != null) result.metas().putAll(source.meta());
        return result;
    }

    public List<McpServer> servers() { return servers; }
    public Collection<FunctionTool> tools() { return List.copyOf(tools); }

    @Override public void close() {
        for (AutoCloseable client : clients) {
            try { client.close(); } catch (Exception ignored) { }
        }
        clients.clear();
        tools.clear();
    }
}
