package site.sorghum.loopra.integration.cutin;

import org.noear.solon.ai.chat.tool.FunctionTool;
import site.sorghum.cutin.core.context.LoopContext;
import site.sorghum.cutin.core.tool.Tool;
import site.sorghum.cutin.core.tool.ToolCall;
import site.sorghum.cutin.core.tool.ToolDefinition;
import site.sorghum.cutin.core.tool.ToolMetadata;
import site.sorghum.cutin.core.tool.ToolResult;
import site.sorghum.loopra.bin.tool.ToolSchemaSanitizer;
import site.sorghum.loopra.tool.HitlRequiredException;
import site.sorghum.loopra.tool.ToolContext;
import site.sorghum.loopra.tool.solon.mcp.McpFunctionTool;

import java.nio.file.Path;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
  * 把 Loopra/Solon 的 {@link FunctionTool} 桥接为 cutin 的 {@link Tool} 契约。
 * <p>
  * 注册与执行仍留在 Loopra，但工具会镜像到 cutin 中，使
  * {@code DefaultLoopEngine} 可以通过 cutin 工具链派发它。
 * </p>
 */
public final class CutinFunctionToolBridge implements Tool {

    /** Loopra 工具执行上下文（__cwd / ctx），由 AgentLoop 在执行线程内注入。 */
    private static final ThreadLocal<Map<String, Object>> CALL_CONTEXT = new ThreadLocal<>();

    private final FunctionTool delegate;
    private final ToolDefinition definition;

    public CutinFunctionToolBridge(FunctionTool delegate) {
        this.delegate = Objects.requireNonNull(delegate, "delegate");
        this.definition = buildDefinition(delegate);
    }

    @Override
    public String id() {
        return delegate.name();
    }

    @Override
    public ToolDefinition definition() {
        return definition;
    }

    @Override
    public ToolResult call(ToolCall call, LoopContext context) {
        try {
            Map<String, Object> args = new LinkedHashMap<>(call.arguments());
            // MCP 的 handler 会把整个 Map 原样作为远端 CallToolRequest.arguments。
            // Loopra 内部 ctx 可能包含 AgentLoop/sessionStore，不能跨协议边界序列化。
            // 本地 Solon 工具仍保留原有运行时上下文注入。
            if (!(delegate instanceof McpFunctionTool)) {
                args.putAll(effectiveCallContext(context));
            }
            org.noear.solon.ai.chat.tool.ToolResult result = delegate.call(args);
            String content = result == null ? "" : result.getContent();
            return ToolResult.success(call.id(), content == null ? "" : content);
        } catch (HitlRequiredException exception) {
            throw exception;
        } catch (Throwable throwable) {
            String message = throwable.getMessage();
            return ToolResult.failure(
                call.id(),
                message == null ? throwable.getClass().getName() : message
            );
        }
    }

    private static Map<String, Object> effectiveCallContext(LoopContext context) {
        Map<String, Object> callContext = new LinkedHashMap<>();
        Map<String, Object> threadContext = CALL_CONTEXT.get();
        if (threadContext != null) {
            callContext.putAll(threadContext);
        }

        String workingDirectory = workingDirectory(context);
        if (workingDirectory == null) {
            return callContext;
        }

        ToolContext existing = callContext.get("ctx") instanceof ToolContext toolContext
            ? toolContext
            : null;
        String sessionId = existing == null
            ? sessionId(context)
            : existing.getSessionId();
        String stateRoot = existing == null
            ? workingDirectory
            : pathString(existing.getStateRootDir(), workingDirectory);
        callContext.put("__cwd", workingDirectory);
        callContext.put("ctx", new ToolContext(
            existing == null ? Map.of() : existing.getParams(),
            workingDirectory,
            stateRoot,
            sessionId
        ));
        return callContext;
    }

    private static String workingDirectory(LoopContext context) {
        Path path = context == null ? null : context.workingDirectory();
        return path == null ? null : path.toAbsolutePath().normalize().toString();
    }

    private static String sessionId(LoopContext context) {
        if (context == null) {
            return null;
        }
        Object value = context.variables().get("sessionId");
        return value == null || String.valueOf(value).isBlank() ? null : String.valueOf(value);
    }

    private static String pathString(Path path, String fallback) {
        return path == null ? fallback : path.toAbsolutePath().normalize().toString();
    }

    /**
     * 注入当前工具线程的 Loopra 执行上下文。
     * <p>
     * cutin 的 {@link ToolCall#arguments()} 只携带模型参数；Loopra 原有
     * {@code __cwd}/{@code ctx} 等运行期上下文通过该 ThreadLocal 透传给 Solon 工具。
     * </p>
     */
    public static void setCallContext(Map<String, Object> callContext) {
        CALL_CONTEXT.set(callContext == null ? null : new HashMap<>(callContext));
    }

    public static void clearCallContext() {
        CALL_CONTEXT.remove();
    }

    private static ToolDefinition buildDefinition(FunctionTool tool) {
        Map<String, Object> schema = ToolSchemaSanitizer.sanitize(tool.inputSchema());
        Map<String, Object> meta = tool.meta() == null ? Map.of() : tool.meta();
        boolean readOnly = site.sorghum.loopra.bin.tool.ToolMetadata.isReadOnly(tool);
        boolean stormExempt = site.sorghum.loopra.bin.tool.ToolMetadata.isStormExempt(tool);
        long timeoutMillis = metaLong(meta.get("timeoutMillis"));
        Set<String> roles = rolesFrom(meta.get("roles"));
        Map<String, Object> attributes = new LinkedHashMap<>();
        for (Map.Entry<String, Object> entry : meta.entrySet()) {
            if (entry.getValue() != null) {
                attributes.put(entry.getKey(), entry.getValue());
            }
        }
        return new ToolDefinition(
            tool.name(),
            tool.description(),
            schema,
            new ToolMetadata(readOnly, stormExempt, timeoutMillis, roles, attributes)
        );
    }

    private static long metaLong(Object value) {
        if (value instanceof Number number) {
            return number.longValue();
        }
        if (value != null) {
            try {
                return Long.parseLong(String.valueOf(value));
            } catch (NumberFormatException ignored) {
                return 0L;
            }
        }
        return 0L;
    }

    private static Set<String> rolesFrom(Object value) {
        if (value instanceof List<?> list) {
            Set<String> roles = new HashSet<>();
            for (Object item : list) {
                if (item != null) {
                    roles.add(String.valueOf(item));
                }
            }
            return Set.copyOf(roles);
        }
        if (value != null && !String.valueOf(value).isBlank()) {
            return Set.of(String.valueOf(value).split(","));
        }
        return Set.of();
    }
}
