package site.sorghum.loopra.bin.mcp;

import io.modelcontextprotocol.json.McpJsonDefaults;
import io.modelcontextprotocol.server.McpAsyncServer;
import io.modelcontextprotocol.server.McpServerFeatures;
import io.modelcontextprotocol.server.McpStatelessAsyncServer;
import io.modelcontextprotocol.server.McpStatelessServerFeatures;
import io.modelcontextprotocol.spec.McpSchema;
import org.noear.snack4.ONode;
import org.noear.solon.ai.chat.tool.FunctionTool;
import org.noear.solon.ai.mcp.server.McpServerEndpointProvider;
import org.noear.solon.ai.mcp.server.manager.StatefulMcpServerHost;
import org.noear.solon.ai.mcp.server.manager.StatelessMcpServerHost;
import site.sorghum.loopra.bin.tool.ToolMetadata;

import java.lang.reflect.Field;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 为 Solon AI MCP 注册的工具补充 MCP 标准安全提示。
 *
 * <p>Solon AI 4.0.6 的 {@code StatefulToolRegistry} 只把 {@code returnDirect}
 * 写入 {@code ToolAnnotations}，因此 Loopra 需要在工具注册完成后替换工具描述，
 * 保留原有 handler 的同时补上 ChatGPT 等客户端使用的安全字段。当前依赖没有公开
 * 工具 handler 列表，只能通过 MCP server 的稳定字段和公开 specification API 完成
 * 这一步；反射失败时保留 Solon 的原始注册结果，不影响原有工具调用。</p>
 */
final class McpToolAnnotationSupport {

    private static final String TOOLS_FIELD = "tools";

    private McpToolAnnotationSupport() {
    }

    static void apply(McpServerEndpointProvider provider) {
        if (provider == null || provider.getServer() == null) {
            return;
        }

        Map<String, FunctionTool> tools = new LinkedHashMap<>();
        Collection<FunctionTool> registered = provider.getTools();
        if (registered != null) {
            for (FunctionTool tool : registered) {
                if (tool != null && tool.name() != null) {
                    tools.put(tool.name(), tool);
                }
            }
        }

        try {
            if (provider.getServer() instanceof StatefulMcpServerHost stateful) {
                replaceStatefulTools(stateful.getServer(), tools);
            } else if (provider.getServer() instanceof StatelessMcpServerHost stateless) {
                replaceStatelessTools(stateless.getServer(), tools);
            }
        } catch (ReflectiveOperationException | RuntimeException e) {
            // 依赖升级后字段可能发生变化；安全提示是增强信息，不能让 MCP endpoint 起不来。
            org.slf4j.LoggerFactory.getLogger(McpToolAnnotationSupport.class)
                    .warn("[mcp-export] 补充工具安全标注失败，保留 Solon 默认工具描述", e);
        }
    }

    private static void replaceStatefulTools(McpAsyncServer server,
                                             Map<String, FunctionTool> tools)
            throws ReflectiveOperationException {
        if (server == null) {
            return;
        }

        List<McpServerFeatures.AsyncToolSpecification> specifications =
                toolSpecifications(server, McpServerFeatures.AsyncToolSpecification.class);
        for (int i = 0; i < specifications.size(); i++) {
            McpServerFeatures.AsyncToolSpecification specification = specifications.get(i);
            FunctionTool functionTool = tools.get(specification.tool().name());
            if (functionTool == null) {
                continue;
            }

            McpSchema.Tool annotated = annotatedTool(functionTool, specification.tool());
            if (!annotated.equals(specification.tool())) {
                specifications.set(i, new McpServerFeatures.AsyncToolSpecification(
                        annotated, specification.callHandler()));
            }
        }
    }

    private static void replaceStatelessTools(McpStatelessAsyncServer server,
                                              Map<String, FunctionTool> tools)
            throws ReflectiveOperationException {
        if (server == null) {
            return;
        }

        List<McpStatelessServerFeatures.AsyncToolSpecification> specifications =
                toolSpecifications(server, McpStatelessServerFeatures.AsyncToolSpecification.class);
        for (int i = 0; i < specifications.size(); i++) {
            McpStatelessServerFeatures.AsyncToolSpecification specification = specifications.get(i);
            FunctionTool functionTool = tools.get(specification.tool().name());
            if (functionTool == null) {
                continue;
            }

            McpSchema.Tool annotated = annotatedTool(functionTool, specification.tool());
            if (!annotated.equals(specification.tool())) {
                specifications.set(i, new McpStatelessServerFeatures.AsyncToolSpecification(
                        annotated, specification.callHandler()));
            }
        }
    }

    @SuppressWarnings("unchecked")
    private static <T> List<T> toolSpecifications(Object server, Class<T> specificationType)
            throws ReflectiveOperationException {
        Field field = server.getClass().getDeclaredField(TOOLS_FIELD);
        field.setAccessible(true);
        Object value = field.get(server);
        if (!(value instanceof List<?> list)) {
            throw new IllegalStateException("MCP server tools field is not a list");
        }
        for (Object item : list) {
            if (!specificationType.isInstance(item)) {
                throw new IllegalStateException("Unexpected MCP tool specification type");
            }
        }
        return (List<T>) list;
    }

    static McpSchema.Tool annotatedTool(FunctionTool functionTool, McpSchema.Tool existing) {
        boolean readOnly = ToolMetadata.isReadOnly(functionTool);
        McpSchema.ToolAnnotations existingAnnotations = existing.annotations();
        McpSchema.ToolAnnotations annotations = McpSchema.ToolAnnotations.builder()
                .title(existingAnnotations == null ? null : existingAnnotations.title())
                .readOnlyHint(readOnly)
                // 对未知工具按有副作用处理，避免客户端把它当成安全的只读操作。
                .destructiveHint(!readOnly)
                .idempotentHint(readOnly)
                .openWorldHint(openWorldHint(functionTool))
                .returnDirect(functionTool.returnDirect())
                .build();

        McpSchema.Tool.Builder builder = McpSchema.Tool.builder()
                .name(functionTool.name())
                .title(functionTool.title())
                .description(functionTool.description())
                .meta(functionTool.meta())
                .annotations(annotations)
                .inputSchema(McpJsonDefaults.getMapper(), buildJsonSchema(functionTool));

        if (existing.outputSchema() != null) {
            builder.outputSchema(existing.outputSchema());
        }
        return builder.build();
    }

    private static String buildJsonSchema(FunctionTool functionTool) {
        ONode jsonSchema = new ONode();
        jsonSchema.set("$schema", "http://json-schema.org/draft-07/schema#");
        jsonSchema.setAll(ONode.ofJson(functionTool.inputSchema()).getObject());
        return jsonSchema.toJson();
    }

    private static boolean openWorldHint(FunctionTool functionTool) {
        Object declared = functionTool.meta() == null ? null : functionTool.meta().get("openWorld");
        if (declared != null) {
            return Boolean.parseBoolean(declared.toString());
        }

        String name = functionTool.name();
        return name != null && (name.startsWith("web")
                || name.contains("api")
                || name.contains("http"));
    }
}
