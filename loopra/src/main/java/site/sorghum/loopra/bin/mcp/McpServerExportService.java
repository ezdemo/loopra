package site.sorghum.loopra.bin.mcp;

import lombok.extern.slf4j.Slf4j;
import org.noear.dami2.Dami;
import org.noear.snack4.Feature;
import org.noear.snack4.ONode;
import org.noear.snack4.Options;
import org.noear.snack4.json.JsonWriter;
import org.noear.solon.ai.chat.tool.FunctionTool;
import org.noear.solon.ai.chat.content.ImageBlock;
import org.noear.solon.ai.chat.tool.ToolResult;
import org.noear.solon.ai.mcp.server.McpServerEndpointProvider;
import org.noear.solon.annotation.Component;
import org.noear.solon.annotation.Inject;
import org.noear.solon.core.event.AppLoadEndEvent;
import org.noear.solon.core.event.EventListener;
import site.sorghum.loopra.bin.config.ConfigChangedEvent;
import site.sorghum.loopra.bin.config.ConfigService;
import site.sorghum.loopra.bin.agent.model.ImageToolResult;
import site.sorghum.loopra.bin.tool.ToolMetadata;
import site.sorghum.loopra.bin.tool.ToolRegistry;
import site.sorghum.loopra.bin.tool.ToolScanUtil;
import site.sorghum.loopra.tool.ToolContext;
import site.sorghum.loopra.web.service.AgentService;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * 将 Loopra 当前工具注册表发布为 MCP Server。
 *
 * <p>发布白名单与子代理的 {@code allowedTools} 使用相同语义：null 表示不额外限制，
 * 非 null 表示精确白名单。工具注册表或全局工具权限变化后，已连接的有状态 MCP 客户端
 * 会通过 Solon 的动态工具注册机制收到更新。</p>
 */
@Slf4j
@Component
public class McpServerExportService implements EventListener<AppLoadEndEvent> {

    private static final String CONFIG_FILE = "mcp-server.json";
    private static final Set<String> SUPPORTED_CHANNELS = Set.of(
            "streamable", "streamable_stateless", "sse");

    private final Object lifecycleLock = new Object();

    private volatile McpExportConfig config;
    private volatile McpServerEndpointProvider endpointProvider;
    private volatile String activeSignature;
    private boolean loaded;
    private boolean appLoaded;
    private boolean configListenerRegistered;

    @Inject
    private AgentService agentService;

    private final org.noear.dami2.bus.EventListener<ConfigChangedEvent> configListener = event -> {
        ConfigChangedEvent changed = event.getPayload();
        if (changed == null) return;
        if ("disabledTools".equals(changed.key())
                || "toolReadOnlyOverrides".equals(changed.key())
                || "disabledPlugins".equals(changed.key())
                || "workspaceDir".equals(changed.key())) {
            refreshTools();
        }
    };

    /**
     * 获取当前发布配置及工具清单。
     */
    public McpExportConfigDTO getConfig() {
        synchronized (lifecycleLock) {
            ensureLoadedLocked();
            return toDTO(config);
        }
    }

    /**
     * 保存配置并立即应用到 MCP endpoint。
     */
    public McpExportConfigDTO saveConfig(McpExportConfig requested) {
        if (requested == null) {
            throw new IllegalArgumentException("MCP 发布配置不能为空");
        }

        synchronized (lifecycleLock) {
            ensureLoadedLocked();
            McpExportConfig previous = config;
            McpExportConfig normalized = normalize(requested);
            try {
                if (appLoaded) {
                    applyConfigLocked(normalized);
                }
                config = normalized;
                saveToFile(normalized);
                log.info("[mcp-export] 配置已保存: enabled={}, channel={}, endpoint={}, tools={}",
                        normalized.enabled, normalized.channel, normalized.endpoint,
                        normalized.allowedTools == null ? "all" : normalized.allowedTools.size());
                return toDTO(normalized);
            } catch (RuntimeException e) {
                // 保存新配置失败时尽量恢复之前正在服务的 endpoint。
                config = previous;
                if (appLoaded) {
                    try {
                        applyConfigLocked(previous);
                    } catch (RuntimeException restoreError) {
                        log.error("[mcp-export] 恢复旧配置失败", restoreError);
                    }
                }
                throw e;
            }
        }
    }

    /**
     * 手动刷新当前 endpoint 的工具清单。主要用于切换项目或插件后立即同步。
     */
    public McpExportConfigDTO refreshTools() {
        synchronized (lifecycleLock) {
            ensureLoadedLocked();
            if (appLoaded && config.enabled) {
                if (endpointProvider == null) {
                    applyConfigLocked(config);
                } else {
                    syncTools(endpointProvider, config);
                }
            }
            return toDTO(config);
        }
    }

    @Override
    public void onEvent(AppLoadEndEvent event) {
        synchronized (lifecycleLock) {
            ensureLoadedLocked();
            appLoaded = true;
            if (!configListenerRegistered) {
                Dami.bus().listen("config.changed", configListener);
                configListenerRegistered = true;
            }
            if (config.enabled) {
                try {
                    applyConfigLocked(config);
                } catch (RuntimeException e) {
                    log.error("[mcp-export] 启动 MCP endpoint 失败: {}", config.endpoint, e);
                }
            }
        }
    }

    private void ensureLoadedLocked() {
        if (loaded) return;
        McpExportConfig loadedConfig = loadFromFile();
        try {
            config = normalize(loadedConfig == null ? new McpExportConfig() : loadedConfig);
        } catch (IllegalArgumentException e) {
            log.warn("[mcp-export] 配置不合法，使用默认配置: {}", e.getMessage());
            config = new McpExportConfig();
        }
        loaded = true;
    }

    private void applyConfigLocked(McpExportConfig next) {
        if (!next.enabled) {
            stopEndpointLocked();
            return;
        }

        String signature = signature(next);
        if (endpointProvider != null && signature.equals(activeSignature)) {
            syncTools(endpointProvider, next);
            return;
        }

        // 端点地址或 transport 变化时，先释放旧路由再注册新路由。
        stopEndpointLocked();
        McpServerEndpointProvider candidate = buildProvider(next);
        try {
            syncTools(candidate, next);
            candidate.postStart();
            McpToolAnnotationSupport.apply(candidate);
            endpointProvider = candidate;
            activeSignature = signature;
            log.info("[mcp-export] MCP endpoint 已启动: {} ({})", next.endpoint, next.channel);
        } catch (Throwable e) {
            try {
                candidate.stop();
            } catch (Throwable stopError) {
                log.debug("[mcp-export] 清理失败的 MCP endpoint 失败", stopError);
            }
            throw new IllegalStateException("启动 MCP endpoint 失败: " + next.endpoint, e);
        }
    }

    private McpServerEndpointProvider buildProvider(McpExportConfig value) {
        return McpServerEndpointProvider.builder()
                .name(value.name)
                .version(value.version)
                .channel(value.channel)
                .mcpEndpoint(value.endpoint)
                .build();
    }

    private void stopEndpointLocked() {
        McpServerEndpointProvider provider = endpointProvider;
        endpointProvider = null;
        activeSignature = null;
        if (provider == null) return;
        try {
            provider.stop();
        } catch (Throwable e) {
            log.warn("[mcp-export] 停止 MCP endpoint 失败", e);
        }
    }

    private void syncTools(McpServerEndpointProvider provider, McpExportConfig value) {
        ToolSnapshot snapshot = discoverTools();
        Set<String> desiredNames = new LinkedHashSet<>();
        for (FunctionTool tool : snapshot.enabled.values()) {
            if (value.allowedTools == null || value.allowedTools.contains(tool.name())) {
                desiredNames.add(tool.name());
            }
        }

        // 先移除不再发布的工具，保留同名工具可以让有状态客户端收到最小变更集。
        for (FunctionTool current : new ArrayList<>(provider.getTools())) {
            if (!desiredNames.contains(current.name())) {
                provider.removeTool(current.name());
            }
        }

        Set<String> currentNames = new LinkedHashSet<>();
        for (FunctionTool current : provider.getTools()) {
            currentNames.add(current.name());
        }
        for (FunctionTool tool : snapshot.enabled.values()) {
            if (desiredNames.contains(tool.name()) && !currentNames.contains(tool.name())) {
                provider.addTool(new ContextAwareFunctionTool(tool, this));
            }
        }

        // Solon AI 4.0.6 默认只输出 returnDirect；补充标准安全提示，便于 ChatGPT
        // 等客户端判断工具是否只读、是否可能产生破坏性副作用。
        McpToolAnnotationSupport.apply(provider);
    }

    private ToolSnapshot discoverTools() {
        Path workspace = currentWorkspace();
        try {
            ToolRegistry registry = agentService == null ? null : agentService.getSharedToolRegistry();
            Path registryWorkspace = registry == null || registry.getEnvironment() == null
                    ? null : registry.getEnvironment().executionRoot();
            boolean sameWorkspace = Objects.equals(normalizePath(registryWorkspace), workspace);
            if (registry != null && sameWorkspace) {
                registry.refresh();
                Map<String, FunctionTool> all = new LinkedHashMap<>(registry.allScanned());
                registry.all().forEach(all::putIfAbsent);
                if (!all.isEmpty()) {
                    // 共享注册表可能仍保留初始化时的禁用快照；这里再按当前配置过滤，
                    // 确保 MCP 发布不会因为配置热更新而重新暴露全局禁用工具。
                    Set<String> disabled = currentDisabledTools();
                    Map<String, Boolean> overrides = currentReadOnlyOverrides();
                    Map<String, FunctionTool> enabled = new LinkedHashMap<>();
                    all.values().forEach(tool -> {
                        ToolMetadata.applyReadOnlyOverride(tool, overrides.get(tool.name()));
                        if (!disabled.contains(tool.name())
                                && isForceAllowed(registry, tool.name())) {
                            enabled.put(tool.name(), tool);
                        }
                    });
                    return new ToolSnapshot(all, enabled);
                }
            }
        } catch (Exception e) {
            log.warn("[mcp-export] 从共享 ToolRegistry 获取工具失败，回退扫描: {}", e.getMessage());
        }

        Map<String, FunctionTool> all = new LinkedHashMap<>();
        Map<String, FunctionTool> enabled = new LinkedHashMap<>();
        Set<String> disabled = currentDisabledTools();
        Map<String, Boolean> overrides = currentReadOnlyOverrides();
        try {
            for (FunctionTool tool : ToolScanUtil.scanTools(workspace)) {
                if (tool == null || tool.name() == null || tool.name().isBlank()) continue;
                ToolMetadata.applyReadOnlyOverride(tool, overrides.get(tool.name()));
                if (all.putIfAbsent(tool.name(), tool) == null && !disabled.contains(tool.name())) {
                    enabled.put(tool.name(), tool);
                }
            }
        } catch (Exception e) {
            log.warn("[mcp-export] 扫描 Loopra 工具失败: {}", e.getMessage());
        }
        return new ToolSnapshot(all, enabled);
    }

    private static boolean isForceAllowed(ToolRegistry registry, String toolName) {
        Set<String> forceDeny = registry.getForceDenyTools();
        if (forceDeny != null && forceDeny.contains(toolName)) return false;
        Set<String> forceAllow = registry.getForceAllowTools();
        return forceAllow == null || forceAllow.contains(toolName);
    }

    private static Path normalizePath(Path path) {
        return path == null ? null : path.toAbsolutePath().normalize();
    }

    private Set<String> currentDisabledTools() {
        var cfg = ConfigService.getConfig();
        return cfg == null || cfg.disabledTools() == null
                ? Collections.emptySet() : new LinkedHashSet<>(cfg.disabledTools());
    }

    private Map<String, Boolean> currentReadOnlyOverrides() {
        if (ConfigService.getConfig() == null) return Collections.emptyMap();
        Map<String, Boolean> overrides = ConfigService.getToolReadOnlyOverrides();
        return overrides == null ? Collections.emptyMap() : overrides;
    }

    private Path currentWorkspace() {
        String path = agentService == null ? null : agentService.getCurrentProject();
        if (path == null || path.isBlank()) {
            var cfg = ConfigService.getConfig();
            if (cfg != null && cfg.workspaceDir() != null) {
                return cfg.workspaceDir().toAbsolutePath().normalize();
            }
            return null;
        }
        return Paths.get(path).toAbsolutePath().normalize();
    }

    private McpExportConfigDTO toDTO(McpExportConfig value) {
        ToolSnapshot snapshot = discoverTools();
        List<McpExportToolInfoDTO> tools = snapshot.all.values().stream()
                .sorted(Comparator.comparing(FunctionTool::name))
                .map(tool -> {
                    boolean enabled = snapshot.enabled.containsKey(tool.name());
                    boolean exposed = enabled
                            && (value.allowedTools == null || value.allowedTools.contains(tool.name()));
                    return new McpExportToolInfoDTO(
                            tool.name(),
                            tool.description() == null ? "" : tool.description(),
                            ToolMetadata.isReadOnly(tool),
                            enabled,
                            exposed);
                })
                .toList();
        List<String> allowedTools = value.allowedTools == null
                ? null : List.copyOf(value.allowedTools);
        return new McpExportConfigDTO(value.enabled, value.name, value.version, value.channel,
                value.endpoint, allowedTools, tools, effectiveEndpoint(value));
    }

    private String effectiveEndpoint(McpExportConfig value) {
        McpServerEndpointProvider provider = endpointProvider;
        if (provider != null && signature(value).equals(activeSignature)) {
            String endpoint = provider.getMcpEndpoint();
            if (endpoint != null && !endpoint.isBlank()) return endpoint;
        }
        return value.endpoint;
    }

    private static McpExportConfig normalize(McpExportConfig source) {
        McpExportConfig target = new McpExportConfig();
        if (source == null) return target;

        target.enabled = source.enabled;
        target.name = trimOrDefault(source.name, "loopra");
        if (!target.name.matches("^[a-zA-Z0-9_-]+$")) {
            throw new IllegalArgumentException("MCP server 名称仅允许字母、数字、下划线和连字符");
        }
        target.version = trimOrDefault(source.version, "1.0.0");
        target.channel = normalizeChannel(source.channel);
        target.endpoint = normalizeEndpoint(source.endpoint);
        if (source.allowedTools != null) {
            LinkedHashSet<String> names = new LinkedHashSet<>();
            for (String name : source.allowedTools) {
                if (name != null && !name.isBlank()) names.add(name.trim());
            }
            target.allowedTools = new ArrayList<>(names);
        }
        return target;
    }

    private static String trimOrDefault(String value, String fallback) {
        return value == null || value.isBlank() ? fallback : value.trim();
    }

    private static String normalizeChannel(String value) {
        String channel = trimOrDefault(value, "streamable").toLowerCase(java.util.Locale.ROOT);
        if (!SUPPORTED_CHANNELS.contains(channel)) {
            throw new IllegalArgumentException("不支持的 MCP 传输类型: " + value
                    + "，仅支持 streamable / streamable_stateless / sse");
        }
        return channel;
    }

    private static String normalizeEndpoint(String value) {
        String endpoint = trimOrDefault(value, "/mcp");
        if (!endpoint.startsWith("/") || endpoint.contains(" ") || endpoint.contains("\t")
                || endpoint.contains("\r") || endpoint.contains("\n")) {
            throw new IllegalArgumentException("MCP endpoint 必须是以 / 开头的不含空格路径");
        }
        while (endpoint.length() > 1 && endpoint.endsWith("/")) {
            endpoint = endpoint.substring(0, endpoint.length() - 1);
        }
        return endpoint;
    }

    private static String signature(McpExportConfig value) {
        return value.name + "\u0000" + value.version + "\u0000"
                + value.channel + "\u0000" + value.endpoint;
    }

    private Path configPath() {
        return Paths.get(System.getProperty("user.home"), ".loopra", CONFIG_FILE);
    }

    private void saveToFile(McpExportConfig value) {
        try {
            Path path = configPath();
            Files.createDirectories(path.getParent());
            String json = JsonWriter.write(ONode.ofBean(value), Options.of(Feature.Write_PrettyFormat));
            Files.writeString(path, json, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException("保存 MCP 发布配置失败", e);
        }
    }

    private McpExportConfig loadFromFile() {
        Path path = configPath();
        if (!Files.exists(path)) return null;
        try {
            return ONode.ofJson(Files.readString(path, StandardCharsets.UTF_8))
                    .toBean(McpExportConfig.class);
        } catch (Exception e) {
            log.warn("[mcp-export] 读取配置失败，使用默认配置: {}", path, e);
            return null;
        }
    }

    private record ToolSnapshot(Map<String, FunctionTool> all,
                                Map<String, FunctionTool> enabled) {
    }

    /**
     * MCP 请求不能让客户端伪造 Loopra 的 ctx 或 __cwd；每次调用都注入当前工作区上下文。
     */
    private static final class ContextAwareFunctionTool implements FunctionTool {
        private final FunctionTool delegate;
        private final McpServerExportService owner;

        private ContextAwareFunctionTool(FunctionTool delegate, McpServerExportService owner) {
            this.delegate = Objects.requireNonNull(delegate, "delegate");
            this.owner = Objects.requireNonNull(owner, "owner");
        }

        @Override
        public String name() {
            return delegate.name();
        }

        @Override
        public String title() {
            String title = delegate.title();
            return title == null || title.isBlank() ? readableToolTitle(name()) : title;
        }

        @Override
        public String description() {
            return delegate.description();
        }

        @Override
        public boolean returnDirect() {
            return delegate.returnDirect();
        }

        @Override
        public String inputSchema() {
            return ONode.serialize(site.sorghum.loopra.bin.tool.ToolSchemaSanitizer
                    .sanitize(delegate.inputSchema()));
        }

        @Override
        public String outputSchema() {
            return delegate.outputSchema();
        }

        @Override
        public org.noear.solon.ai.chat.tool.ToolCallResultConverter resultConverter() {
            return delegate.resultConverter();
        }

        @Override
        public java.lang.reflect.Type returnType() {
            return delegate.returnType();
        }

        @Override
        public Object handle(Map<String, Object> args) throws Throwable {
            Object result = delegate.handle(owner.withRuntimeContext(args));
            if (!name().startsWith("browser_") || !(result instanceof String text)) return result;

            ImageToolResult.ImageResult image = ImageToolResult.parseResult(text);
            if (image != null) return toMcpImageResult(image);
            if (isBrowserFailure(text)) {
                // MCP responder 只有在工具抛异常时才会设置 isError=true；浏览器工具的
                // 结构化失败结果在 Loopra 内部仍保留为文本，因此在 MCP 边界转换一次。
                throw new IllegalStateException(browserFailureMessage(text));
            }
            return result;
        }

        @Override
        public Map<String, Object> meta() {
            return delegate.meta();
        }

        @Override
        public void metaPut(String key, Object value) {
            delegate.metaPut(key, value);
        }
    }

    /**
     * MCP 的 title 是可选字段，但 ChatGPT 等客户端对空字符串的兼容性不一致。
     * Loopra 的工具大多只有机器可读的 snake_case 名称，这里提供稳定的人类可读回退值。
     */
    static String readableToolTitle(String toolName) {
        if (toolName == null || toolName.isBlank()) {
            return "Loopra Tool";
        }

        String normalized = toolName.trim()
                .replaceAll("([a-z0-9])([A-Z])", "$1 $2")
                .replace('-', ' ')
                .replace('_', ' ')
                .replaceAll("\\s+", " ");
        StringBuilder title = new StringBuilder(normalized.length());
        for (String word : normalized.split(" ")) {
            if (word.isBlank()) continue;
            if (title.length() > 0) title.append(' ');
            title.append(Character.toUpperCase(word.charAt(0)));
            if (word.length() > 1) title.append(word.substring(1));
        }
        return title.length() == 0 ? "Loopra Tool" : title.toString();
    }

    /**
     * 将 Loopra 内部的图片文本协议转换成 Solon MCP 可识别的多模态 ToolResult。
     * 内部 Agent 仍继续使用 ImageToolResult，不改变现有回放协议。
     */
    static ToolResult toMcpImageResult(ImageToolResult.ImageResult image) {
        String dataUri = image == null ? "" : image.dataUri();
        int comma = dataUri.indexOf(',');
        if (!dataUri.startsWith("data:image/") || comma < 0) {
            throw new IllegalArgumentException("browser screenshot image data is invalid");
        }
        String metadata = dataUri.substring("data:".length(), comma);
        String mimeType = metadata.split(";", 2)[0];
        if (!metadata.toLowerCase(java.util.Locale.ROOT).contains(";base64")) {
            throw new IllegalArgumentException("browser screenshot must use base64 image data");
        }
        String encoded = dataUri.substring(comma + 1);
        // 校验一次，避免把损坏的图片作为成功的 MCP content 发出去。
        Base64.getDecoder().decode(encoded);
        return ToolResult.success(image.summary())
                .addBlock(ImageBlock.ofBase64(encoded, mimeType));
    }

    static boolean isBrowserFailure(String result) {
        if (result == null) return false;
        if (result.startsWith("BROWSER_UNAVAILABLE:") || result.startsWith("BROWSER_ERROR:")) return true;
        try {
            ONode success = ONode.ofJson(result).get("success");
            return success != null && !success.isNull() && success.isValue() && !success.getBoolean();
        } catch (Exception ignored) {
            return false;
        }
    }

    static String browserFailureMessage(String result) {
        try {
            ONode error = ONode.ofJson(result).get("error");
            if (error != null && !error.isNull()) {
                String code = error.get("code").getString();
                String message = error.get("message").getString();
                if (code != null && message != null) return code + ": " + message;
                if (message != null) return message;
            }
        } catch (Exception ignored) {
            // 兼容旧版本浏览器工具返回的纯文本错误。
        }
        return result == null || result.isBlank() ? "Browser operation failed" : result;
    }

    private Map<String, Object> withRuntimeContext(Map<String, Object> args) {
        Map<String, Object> effective = args == null
                ? new LinkedHashMap<>() : new LinkedHashMap<>(args);
        Path workspace = currentWorkspace();
        String root = workspace == null ? null : workspace.toString();
        effective.put("__cwd", root);
        effective.put("ctx", new ToolContext(
                new LinkedHashMap<>(), root, root, "mcp"));
        return effective;
    }
}
