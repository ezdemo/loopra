package site.sorghum.loopra.web.service;

import com.agentclientprotocol.sdk.client.AcpClient;
import com.agentclientprotocol.sdk.client.AcpSyncClient;
import com.agentclientprotocol.sdk.json.TypeRef;
import com.agentclientprotocol.sdk.spec.AcpClientTransport;
import com.agentclientprotocol.sdk.spec.AcpSchema;
import com.agentclientprotocol.sdk.spec.AcpSchema.*;
import org.noear.snack4.ONode;
import reactor.core.publisher.Mono;
import site.sorghum.loopra.bin.acp.AcpAgentOutput;
import site.sorghum.loopra.bin.acp.AcpConfigOption;
import site.sorghum.loopra.bin.agent.model.FileChange;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.bin.session.SessionFileChangeTracker;
import site.sorghum.loopra.bin.session.SessionStore.AcpPlanEntry;
import site.sorghum.loopra.bin.session.SessionStore.AcpCommand;
import site.sorghum.loopra.tool.AgentOutput;
import site.sorghum.loopra.web.common.ServiceException;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/** Transport-independent ACP client; owns one active workbench turn and its permissions. */
public final class AcpWorkbenchClient implements AutoCloseable {
    /** Claude Code's flattened subagent transcript: child traffic stays on the root session. */
    private static final String SUBAGENT_TRANSCRIPT = "subagent-transcript";
    private static final String CLAUDE_META = "claudeCode";
    private static final String PARENT_TOOL_USE_ID = "parentToolUseId";

    private final AcpSyncClient client;
    private volatile AgentOutput output;
    private final AtomicBoolean cancelled = new AtomicBoolean();
    private final Map<String, PendingPermission> permissions = new ConcurrentHashMap<>();
    private final Map<String, String> toolNames = new ConcurrentHashMap<>();
    /** Raw input of each announced tool call, used to title a subagent's Agent/Task block. */
    private final Map<String, Object> toolInputs = new ConcurrentHashMap<>();
    /** Agent/Task tool calls that own a rendered subagent block. */
    private final java.util.Set<String> subAgentIds = ConcurrentHashMap.newKeySet();
    /** Parent calls whose subagent block already reported its end. */
    private final java.util.Set<String> endedSubAgents = ConcurrentHashMap.newKeySet();
    /** Nested tool call id -> the Agent/Task call that spawned it. */
    private final Map<String, String> subToolParents = new ConcurrentHashMap<>();
    /** Native ACP child session -> its immediate parent; only announced children are accepted. */
    private final Map<String, String> childSessions = new ConcurrentHashMap<>();
    /** Root-routed child approvals can be attributed only when the raw tool id is unambiguous. */
    private final Map<String, String> childPermissionTools = new ConcurrentHashMap<>();
    private final boolean requestChildSessions;
    private volatile boolean childSessionsSupported;
    /** Optional owner hook that persists subagent traffic for the right-hand replay panel. */
    private volatile java.util.function.BiConsumer<String, Map<String, Object>> subAgentListener;
    /** ACP diff content by tool call; the final PostToolUse update replaces the preview. */
    private final Map<String, List<ToolCallDiff>> toolDiffs = new ConcurrentHashMap<>();
    private final java.util.Set<String> reportedFileChanges = ConcurrentHashMap.newKeySet();
    private volatile String sessionId;
    private volatile boolean nativeEvents;
    private volatile boolean replaying;
    private InitializeResponse initialized;
    private volatile List<AcpConfigOption> configuration = List.of();
    private volatile boolean configOptionsSupported;
    /** Optional owner hook so persistent sessions can save Agent-originated changes. */
    private volatile java.util.function.Consumer<List<AcpConfigOption>> configListener;
    /** The Agent's last reported context usage; ACP omits cumulative session tokens. */
    private volatile Usage lastUsage = new Usage(0, 0, null, null, null);
    private volatile java.util.function.Consumer<Usage> usageListener;
    private volatile java.util.function.Consumer<List<AcpPlanEntry>> planListener;
    private volatile java.util.function.Consumer<List<AcpCommand>> commandsListener;
    private final AcpElicitations elicitations = new AcpElicitations(
            source -> !cancelled.get() && (source.equals(sessionId) || childSessions.containsKey(source)),
            (type, data) -> output.sendEvent(type, data));

    /** Last `usage_update` values; later updates may omit cost or model. */
    public record Usage(long used, long size, Double cost, String currency, String model) {}

    public AcpWorkbenchClient(AcpClientTransport transport, AgentOutput output) {
        this(transport, output, false);
    }

    public AcpWorkbenchClient(AcpClientTransport transport, AgentOutput output, boolean requestChildSessions) {
        this.output = output;
        this.requestChildSessions = requestChildSessions;
        AcpClientTransport observed = new AcpClientTransport() {
            public Mono<Void> connect(java.util.function.Function<Mono<JSONRPCMessage>, Mono<JSONRPCMessage>> handler) {
                return transport.connect(message -> handler.apply(message.map(AcpWorkbenchClient.this::observeResponse)));
            }
            public Mono<Void> sendMessage(JSONRPCMessage message) {
                // SDK 0.14 predates the canonical draft capability; preserve it on the wire.
                if (requestChildSessions && message instanceof JSONRPCRequest request && "initialize".equals(request.method())) {
                    Map<String, Object> params = new java.util.LinkedHashMap<>(transport.unmarshalFrom(request.params(), new TypeRef<Map<String, Object>>() {}));
                    Map<String, Object> capabilities = new java.util.LinkedHashMap<>(
                            transport.unmarshalFrom(params.get("clientCapabilities"), new TypeRef<Map<String, Object>>() {}));
                    capabilities.put("subagents", Map.of());
                    params.put("clientCapabilities", capabilities);
                    message = new JSONRPCRequest(request.jsonrpc(), request.id(), request.method(), params);
                }
                return transport.sendMessage(message);
            }
            public <T> T unmarshalFrom(Object data, TypeRef<T> type) { return transport.unmarshalFrom(data, type); }
            public Mono<Void> closeGracefully() { return transport.closeGracefully(); }
            public void setExceptionHandler(java.util.function.Consumer<Throwable> handler) { transport.setExceptionHandler(handler); }
        };
        client = AcpClient.sync(observed).requestTimeout(Duration.ofHours(12))
                .notificationHandler(AcpSchema.METHOD_SESSION_UPDATE, params -> Mono.fromRunnable(() -> {
                    Map<String, Object> raw = transport.unmarshalFrom(params, new TypeRef<Map<String, Object>>() {});
                    if (!(raw.get("sessionId") instanceof String source)) return;
                    String child = childSessions.containsKey(source) ? source : null;
                    if (sessionId != null && !sessionId.equals(source) && child == null) return;
                    if (!(raw.get("update") instanceof Map<?, ?> update)) return;
                    String kind = String.valueOf(update.get("sessionUpdate"));
                    if ("subagent_spawned".equals(kind) || "subagent_state_update".equals(kind)) {
                        if (childSessionsSupported) acceptChildLifecycle(source, update);
                    } else if ("config_option_update".equals(kind)) {
                        if (child == null) updateConfiguration(update.get("configOptions"));
                    } else if ("plan".equals(kind)) {
                        reportPlan(update.get("entries"), child);
                    } else if ("available_commands_update".equals(kind)) {
                        if (child == null) reportCommands(update.get("availableCommands"));
                    } else accept(transport.unmarshalFrom(params, new TypeRef<SessionNotification>() {}), child);
                }))
                .requestPermissionHandler(this::requestPermission)
                // Keep the raw schema: SDK 0.14 strips newer option metadata and secret flags.
                .requestHandler(AcpSchema.METHOD_ELICITATION_CREATE, params -> elicitations.request(
                        transport.unmarshalFrom(params, new TypeRef<Map<String, Object>>() {}))).build();
    }

    /** SDK 0.14 omits setup configOptions and cannot decode grouped/unknown option variants. */
    private JSONRPCMessage observeResponse(JSONRPCMessage message) {
        if (requestChildSessions && message instanceof JSONRPCResponse response && response.error() == null
                && response.result() instanceof Map<?, ?> result && result.get("agentCapabilities") instanceof Map<?, ?> capabilities
                && capabilities.get("sessionCapabilities") instanceof Map<?, ?> sessions) {
            childSessionsSupported = sessions.get("subagents") instanceof Map<?, ?>;
        }
        if (message instanceof JSONRPCResponse response && response.error() == null && response.result() instanceof Map<?, ?> result
                && result.containsKey("configOptions")) {
            updateConfiguration(result.get("configOptions"));
            Map<Object, Object> supported = new java.util.LinkedHashMap<>(result);
            supported.remove("configOptions");
            return new JSONRPCResponse(response.jsonrpc(), response.id(), supported, null);
        }
        return message;
    }

    private void updateConfiguration(Object raw) {
        configOptionsSupported = true;
        configuration = AcpConfigOption.read(raw);
        var listener = configListener;
        if (listener != null) listener.accept(configuration);
        output.sendEvent("config_options", ONode.serialize(Map.of("configOptions", configuration)));
    }

    public List<AcpConfigOption> configOptions() { return configuration; }

    /** Registers the owner that persists config changes made by the Agent itself. */
    public void setConfigListener(java.util.function.Consumer<List<AcpConfigOption>> listener) {
        this.configListener = listener;
    }

    /** Registers the owner that persists the context usage reported by the Agent. */
    public void setUsageListener(java.util.function.Consumer<Usage> listener) {
        this.usageListener = listener;
    }

    public void setPlanListener(java.util.function.Consumer<List<AcpPlanEntry>> listener) { planListener = listener; }
    public void setCommandsListener(java.util.function.Consumer<List<AcpCommand>> listener) { commandsListener = listener; }

    private void reportPlan(Object raw, String child) {
        if (!(raw instanceof List<?> entries)) return;
        List<AcpPlanEntry> plan = new ArrayList<>();
        for (Object item : entries) if (item instanceof Map<?, ?> entry) {
            String content = firstText(entry, "content"), status = firstText(entry, "status");
            if (content == null || status == null || !List.of("pending", "in_progress", "completed").contains(status)) continue;
            String priority = firstText(entry, "priority");
            plan.add(new AcpPlanEntry(content, status, priority == null ? "medium" : priority));
        }
        if (child != null) {
            sendSubEvent(child, "sub_plan", Map.of("entries", plan));
        } else {
            var listener = planListener;
            if (listener != null) listener.accept(List.copyOf(plan));
            if (!replaying) output.sendEvent("acp_plan", ONode.serialize(Map.of("entries", plan)));
        }
    }

    private void reportCommands(Object raw) {
        if (!(raw instanceof List<?> entries)) return;
        Map<String, AcpCommand> commands = new java.util.LinkedHashMap<>();
        for (Object item : entries) if (item instanceof Map<?, ?> entry) {
            String name = firstText(entry, "name");
            if (name == null || name.matches(".*\\s.*")) continue;
            String hint = entry.get("input") instanceof Map<?, ?> input ? firstText(input, "hint") : null;
            commands.put(name, new AcpCommand(name, firstText(entry, "description"), hint));
        }
        List<AcpCommand> available = List.copyOf(commands.values());
        var listener = commandsListener;
        if (listener != null) listener.accept(available);
        if (!replaying) output.sendEvent("acp_commands", ONode.serialize(Map.of("commands", available)));
    }

    /**
     * Registers the owner that persists subagent events (type + payload), so the
     * workbench's subagent panel can replay them after the turn.
     */
    public void setSubAgentListener(java.util.function.BiConsumer<String, Map<String, Object>> listener) {
        this.subAgentListener = listener;
    }

    public synchronized List<AcpConfigOption> setConfigOption(String id, Object value) {
        if (sessionId == null) throw new ServiceException(409, "Agent 会话正在初始化");
        AcpConfigOption option = configuration.stream().filter(item -> item.id().equals(id)).findFirst()
                .orElseThrow(() -> new ServiceException("Agent 不支持此配置: " + id));
        if (!option.accepts(value)) throw new ServiceException("无效的 Agent 配置值");
        if (!configOptionsSupported) {
            if ("mode".equals(id)) client.setSessionMode(new SetSessionModeRequest(sessionId, (String) value));
            else if ("model".equals(id)) client.setSessionModel(new SetSessionModelRequest(sessionId, (String) value));
            else throw new ServiceException("Agent 不支持此配置");
            configuration = configuration.stream().map(item -> item.id().equals(id)
                    ? new AcpConfigOption(item.id(), item.name(), item.description(), item.category(), item.type(), value, item.options()) : item).toList();
        } else client.setSessionConfigOption(new SetSessionConfigOptionRequest(sessionId, id, value,
                value instanceof Boolean ? "boolean" : null, null));
        return configuration;
    }

    public String open(String cwd) {
        return open(cwd, null, List.of());
    }

    public String open(String cwd, String existingSessionId) {
        return open(cwd, existingSessionId, List.of());
    }

    public String open(String cwd, String existingSessionId, List<String> additionalDirectories) {
        return open(cwd, existingSessionId, additionalDirectories, List.of());
    }

    public String open(String cwd, String existingSessionId, List<String> additionalDirectories, List<McpServer> mcpServers) {
        List<String> directories = additionalDirectories == null ? List.of() : List.copyOf(additionalDirectories);
        List<McpServer> servers = mcpServers == null ? List.of() : List.copyOf(mcpServers);
        initialized = client.initialize(new InitializeRequest(1,
                new ClientCapabilities(new FileSystemCapability(false, false), false, new ElicitationCapabilities(Map.of(), null, null),
                        // Native events for Loopra; the historical Claude Code capability that keeps
                        // a subagent's transcript on the root session so it can be nested in the UI.
                        Map.of(AcpAgentOutput.EXTENSION, true, SUBAGENT_TRANSCRIPT, true)),
                new Implementation("loopra-workbench", "26.9.91", "Loopra Workbench"), null));
        if (initialized.protocolVersion() == null || initialized.protocolVersion() != 1) {
            throw new IllegalStateException("Agent did not negotiate ACP v1");
        }
        nativeEvents = initialized.agentCapabilities() != null && initialized.agentCapabilities().meta() != null
                && Boolean.TRUE.equals(initialized.agentCapabilities().meta().get(AcpAgentOutput.EXTENSION));
        McpCapabilities mcp = initialized.agentCapabilities() == null ? null : initialized.agentCapabilities().mcpCapabilities();
        for (McpServer server : servers) {
            if (server instanceof McpServerHttp && (mcp == null || !Boolean.TRUE.equals(mcp.http())))
                throw new IllegalStateException("Agent 不支持 HTTP MCP: " + site.sorghum.loopra.bin.acp.AcpMcpServers.name(server));
            if (server instanceof McpServerSse && (mcp == null || !Boolean.TRUE.equals(mcp.sse())))
                throw new IllegalStateException("Agent 不支持 SSE MCP: " + site.sorghum.loopra.bin.acp.AcpMcpServers.name(server));
        }
        if (existingSessionId != null) {
            if (initialized.agentCapabilities() == null || !Boolean.TRUE.equals(initialized.agentCapabilities().loadSession())) {
                throw new IllegalStateException("Agent 不支持恢复会话，请创建新会话");
            }
            sessionId = existingSessionId;
            replaying = true;
            try {
                var loaded = client.loadSession(new LoadSessionRequest(existingSessionId, cwd, servers, directories));
                legacyConfiguration(loaded.modes(), loaded.models());
            }
            finally { replaying = false; }
        } else {
            var created = client.newSession(new NewSessionRequest(cwd, servers, directories));
            sessionId = created.sessionId();
            legacyConfiguration(created.modes(), created.models());
        }
        if (sessionId == null || sessionId.isBlank()) throw new IllegalStateException("Agent returned an empty session ID");
        return sessionId;
    }

    private void legacyConfiguration(SessionModeState modes, SessionModelState models) {
        if (configOptionsSupported) return;
        List<AcpConfigOption> options = new ArrayList<>();
        if (modes != null && modes.availableModes() != null) options.add(new AcpConfigOption("mode", "模式", "", "mode", "select",
                modes.currentModeId(), modes.availableModes().stream().map(mode ->
                new AcpConfigOption.Value(mode.id(), mode.name(), mode.description(), null)).toList()));
        if (models != null && models.availableModels() != null) options.add(new AcpConfigOption("model", "模型", "", "model", "select",
                models.currentModelId(), models.availableModels().stream().map(model ->
                new AcpConfigOption.Value(model.modelId(), model.name(), model.description(), null)).toList()));
        configuration = List.copyOf(options);
    }

    public PromptResponse prompt(UserMessage message, Map<String, Object> options) {
        if (cancelled.get()) return new PromptResponse(StopReason.CANCELLED);
        // A background child's tool may finish in a later root turn.
        toolNames.keySet().removeIf(id -> !subToolParents.containsKey(id));
        toolInputs.keySet().removeIf(id -> !subToolParents.containsKey(id));
        toolDiffs.keySet().removeIf(id -> !subToolParents.containsKey(id));
        // Subagent routing survives the turn: a background Agent can start before a prompt
        // boundary and finish after the next one, and re-sending sub_start would truncate
        // the replay. Its call ids are unique, so stale entries cannot collide.
        List<ContentBlock> blocks = new ArrayList<>();
        if (message.getText() != null) blocks.add(new TextContent(message.getText()));
        for (String image : message.getImages()) {
            int comma = image.indexOf(',');
            if (image.startsWith("data:") && comma > 0 && image.substring(0, comma).endsWith(";base64")) {
                blocks.add(new ImageContent("image", image.substring(comma + 1),
                        image.substring(5, image.indexOf(';')), null, null, null));
            } else blocks.add(new ImageContent("image", null, null, image, null, null));
        }
        try { return client.prompt(new PromptRequest(sessionId, blocks, nativeEvents ? options : null)); }
        finally { elicitations.cancel(); }
    }

    private void accept(SessionNotification notification, String child) {
        if (replaying && child == null) return;
        var update = notification.update();
        // Claude Code keeps a subagent's transcript on the root session and stamps every
        // nested update with the Agent/Task call that spawned it. Route those updates into
        // the same `sub_*` events Native subagents emit, so the workbench nests them.
        String subId = child == null ? subAgentRoute(update) : child;
        if (update instanceof AgentMessageChunk chunk) {
            if (nativeEvents && chunk.meta() != null && chunk.meta().get(AcpAgentOutput.EVENT) instanceof Map<?, ?> event) {
                output.sendEvent(String.valueOf(event.get("type")), String.valueOf(event.get("data")));
            } else if (chunk.content() instanceof TextContent text) {
                if (subId == null) output.onContentDelta(text.text());
                else sendSubEvent(subId, "sub_content", Map.of("token", text.text()));
            }
        } else if (update instanceof AgentThoughtChunk chunk && chunk.content() instanceof TextContent text) {
            if (subId == null) output.onReasoningDelta(text.text());
            else sendSubEvent(subId, "sub_reasoning", Map.of("token", text.text()));
        } else if (update instanceof ToolCall call) {
            String key = toolKey(child, call.toolCallId());
            if (child != null) rememberChildTool(key, call.toolCallId(), child);
            String name = toolName(call.title(), call.meta());
            toolNames.put(key, name);
            if (call.rawInput() != null) toolInputs.put(key, call.rawInput());
            captureFileChanges(key, call.content());
            if (subId == null) output.onToolCall(call.toolCallId(), name, ONode.serialize(call.rawInput()));
            else sendSubEvent(subId, "sub_tool_call", Map.of("toolCallId", call.toolCallId(), "name", name,
                    "args", call.rawInput() == null ? "{}" : ONode.serialize(call.rawInput())));
            finishTool(call.toolCallId(), key, name, call.status(), call.rawOutput(), call.content(), subId);
            if (child == null) finishSubAgent(call.toolCallId(), call.status(), call.rawOutput());
        } else if (update instanceof ToolCallUpdateNotification call) {
            String key = toolKey(child, call.toolCallId());
            if (child != null) rememberChildTool(key, call.toolCallId(), child);
            String name = call.title() == null ? toolNames.getOrDefault(key, "unknown")
                    : toolName(call.title(), call.meta());
            toolNames.put(key, name);
            if (call.rawInput() != null) toolInputs.put(key, call.rawInput());
            captureFileChanges(key, call.content());
            if (call.rawInput() != null || call.title() != null) {
                if (subId == null) {
                    output.onToolUpdate(call.toolCallId(), name, call.rawInput() == null ? null : ONode.serialize(call.rawInput()));
                } else {
                    sendSubEvent(subId, "sub_tool_update", Map.of("toolCallId", call.toolCallId(), "name", name,
                            "args", call.rawInput() == null ? "{}" : ONode.serialize(call.rawInput())));
                }
            }
            finishTool(call.toolCallId(), key, name, call.status(), call.rawOutput(), call.content(), subId);
            if (child == null) finishSubAgent(call.toolCallId(), call.status(), call.rawOutput());
        } else if (child == null && update instanceof UsageUpdate usage) {
            reportUsage(usage);
        }
    }

    private static String toolKey(String child, String toolId) {
        return child == null ? toolId : child + "\u0000" + toolId;
    }

    private void rememberChildTool(String key, String toolId, String child) {
        subToolParents.put(key, child);
        childPermissionTools.merge(toolId, child, (previous, current) -> previous.equals(current) ? previous : "");
    }

    /** Draft Codex lifecycle updates are decoded before the older SDK's SessionUpdate union. */
    private void acceptChildLifecycle(String parent, Map<?, ?> update) {
        if (!(update.get("subagentSessionId") instanceof String child) || child.isBlank()
                || child.equals(sessionId) || child.equals(parent)) return;
        if ("subagent_spawned".equals(update.get("sessionUpdate"))) {
            // Never reparent a known child or restart/truncate its transcript on duplicate announcements.
            if (childSessions.putIfAbsent(child, parent) != null) return;
            subAgentIds.add(child);
            Map<String, Object> start = new java.util.LinkedHashMap<>();
            String name = firstText(update, "name"), task = firstText(update, "task");
            start.put("name", name == null ? "Codex" : clip(name));
            start.put("task", task == null ? "子代理" : clip(task));
            if (task != null) start.put("title", clip(task));
            if (childSessions.containsKey(parent)) start.put("parentSubId", parent);
            start.put("startedAt", System.currentTimeMillis());
            sendSubEvent(child, "sub_start", start);
        } else if (parent.equals(childSessions.get(child))) {
            String state = String.valueOf(update.get("state"));
            String status = switch (state) {
                case "completed" -> "completed";
                case "failed" -> "error";
                case "cancelled", "disconnected" -> "aborted";
                default -> null;
            };
            if (status == null || !endedSubAgents.add(child)) return;
            Map<String, Object> end = new java.util.LinkedHashMap<>();
            end.put("status", status);
            end.put("endedAt", System.currentTimeMillis());
            if ("error".equals(status)) end.put("error", "子代理执行失败");
            sendSubEvent(child, "sub_end", end);
        }
    }

    /** The Agent/Task call that owns this nested update, or null for root-session traffic. */
    private String subAgentRoute(SessionUpdate update) {
        Map<String, Object> meta = update instanceof AgentMessageChunk chunk ? chunk.meta()
                : update instanceof AgentThoughtChunk chunk ? chunk.meta()
                : update instanceof ToolCall call ? call.meta()
                : update instanceof ToolCallUpdateNotification call ? call.meta() : null;
        String parent = parentToolUseId(meta);
        if (parent == null) return null;
        String toolCallId = update instanceof ToolCall call ? call.toolCallId()
                : update instanceof ToolCallUpdateNotification call ? call.toolCallId() : null;
        if (parent.equals(toolCallId)) return null;
        if (subAgentIds.add(parent)) {
            endedSubAgents.remove(parent);
            SubAgentInfo info = subAgentInfo(parent);
            Map<String, Object> start = new java.util.LinkedHashMap<>();
            start.put("task", info.task());
            start.put("name", info.name());
            if (info.title() != null) start.put("title", info.title());
            start.put("startedAt", System.currentTimeMillis());
            sendSubEvent(parent, "sub_start", start);
        }
        if (toolCallId != null) subToolParents.put(toolCallId, parent);
        return parent;
    }

    private static String parentToolUseId(Map<String, Object> meta) {
        if (meta == null || !(meta.get(CLAUDE_META) instanceof Map<?, ?> claude)) return null;
        return claude.get(PARENT_TOOL_USE_ID) instanceof String id && !id.isBlank() ? id : null;
    }

    /** Claude's Agent input carries the description/subagent type; fall back to the call title. */
    private SubAgentInfo subAgentInfo(String parentToolCallId) {
        String description = null;
        String name = null;
        String prompt = null;
        if (toolInputs.get(parentToolCallId) instanceof Map<?, ?> input) {
            description = firstText(input, "description");
            name = firstText(input, "subagent_type", "name");
            prompt = firstText(input, "prompt");
        }
        String task = description != null ? description : prompt != null ? prompt : toolNames.get(parentToolCallId);
        return new SubAgentInfo(task == null || task.isBlank() ? "子代理" : clip(task),
                name == null ? "Claude" : clip(name), description == null ? null : clip(description));
    }

    private static String firstText(Map<?, ?> input, String... keys) {
        for (String key : keys) {
            if (input.get(key) instanceof String text && !text.isBlank()) return text;
        }
        return null;
    }

    private record SubAgentInfo(String task, String name, String title) {}

    private static String clip(String text) {
        String oneLine = text.replaceAll("\\s+", " ").trim();
        return oneLine.length() > 80 ? oneLine.substring(0, 80) + "…" : oneLine;
    }

    /**
     * Native subagent ids double as their stored session id. Claude's tool-use id
     * is unique per Agent/Task call, so it is a stable file id after sanitizing.
     */
    private static String subSessionId(String parentToolCallId) {
        if (parentToolCallId.matches("[A-Za-z0-9_-]{1,64}")) return parentToolCallId;
        // Native session IDs are opaque. Hash unsafe/long IDs instead of truncating into collisions.
        try {
            return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256")
                    .digest(parentToolCallId.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }

    private void sendSubEvent(String subId, String type, Map<String, Object> payload) {
        Map<String, Object> event = new java.util.LinkedHashMap<>();
        event.put("subId", subId);
        event.put("subSessionId", subSessionId(subId));
        event.putAll(payload);
        var listener = subAgentListener;
        if (listener != null) listener.accept(type, event);
        if (!replaying) output.sendEvent(type, ONode.serialize(event));
    }

    private void finishSubAgent(String toolCallId, ToolCallStatus status, Object raw) {
        if (status != ToolCallStatus.COMPLETED && status != ToolCallStatus.FAILED) return;
        if (!subAgentIds.contains(toolCallId) || !endedSubAgents.add(toolCallId)) return;
        Map<String, Object> end = new java.util.LinkedHashMap<>();
        end.put("status", status == ToolCallStatus.FAILED ? "error" : "completed");
        if (status == ToolCallStatus.FAILED) end.put("error", raw == null ? "" : String.valueOf(raw));
        end.put("endedAt", System.currentTimeMillis());
        sendSubEvent(toolCallId, "sub_end", end);
    }

    /** Close subagent records that never received a terminal Agent/Task update. */
    private void endActiveSubAgents(String status) {
        for (String id : subAgentIds) {
            if (!endedSubAgents.add(id)) continue;
            sendSubEvent(id, "sub_end", Map.of("status", status, "endedAt", System.currentTimeMillis()));
        }
    }

    /**
     * ACP's `usage_update` carries the current context size, not cumulative token
     * counters. Compaction updates may omit cost and model, so keep the last known
     * values instead of making the usage panel regress to "estimate".
     */
    private void reportUsage(UsageUpdate update) {
        Usage previous = lastUsage;
        long used = update.used() == null ? previous.used() : update.used();
        long size = update.size() == null ? previous.size() : update.size();
        Double cost = update.cost() == null ? previous.cost() : update.cost().amount();
        String currency = update.cost() == null ? previous.currency() : update.cost().currency();
        String model = previous.model();
        if (update.meta() != null && update.meta().get("_claude/model") instanceof String reported && !reported.isBlank()) {
            model = reported;
        }
        Usage current = new Usage(used, size, cost, currency, model);
        lastUsage = current;
        var listener = usageListener;
        if (listener != null) listener.accept(current);
        Map<String, Object> event = new java.util.LinkedHashMap<>();
        event.put("used", used);
        event.put("size", size);
        if (cost != null) {
            event.put("cost", cost);
            event.put("currency", currency);
        }
        if (model != null) event.put("model", model);
        output.sendEvent("usage", ONode.serialize(event));
    }

    private void finishTool(String id, String key, String name, ToolCallStatus status, Object raw,
                            List<ToolCallContent> content, String subId) {
        if (status != ToolCallStatus.COMPLETED && status != ToolCallStatus.FAILED) return;
        String result = raw instanceof String value ? value : raw != null ? ONode.serialize(raw) : toolText(content);
        boolean failed = status == ToolCallStatus.FAILED;
        if (subId == null) output.onToolResult(id, name, result, failed);
        else sendSubEvent(subId, "sub_tool_result", Map.of("toolCallId", id, "name", name,
                "result", result, "status", failed ? "failed" : "completed"));
        if (status == ToolCallStatus.COMPLETED && !replaying) reportFileChanges(key);
    }

    /**
     * ACP exposes edit changes as `diff` content (`path`/`oldText`/`newText`).
     * Keep the latest content per tool call: Edit announces a snippet first and
     * the PostToolUse update then carries the final patch.
     */
    private void captureFileChanges(String toolCallId, List<ToolCallContent> content) {
        if (content == null || content.isEmpty()) return;
        List<ToolCallDiff> diffs = content.stream().filter(ToolCallDiff.class::isInstance)
                .map(ToolCallDiff.class::cast).filter(diff -> diff.path() != null).toList();
        if (!diffs.isEmpty()) toolDiffs.put(toolCallId, diffs);
    }

    /** Report one completed edit as the same `file_changes` event Native agents emit. */
    private void reportFileChanges(String toolCallId) {
        List<ToolCallDiff> diffs = toolDiffs.remove(toolCallId);
        if (diffs == null || diffs.isEmpty() || !reportedFileChanges.add(toolCallId)) return;
        List<FileChange> changes = diffs.stream()
                .map(diff -> SessionFileChangeTracker.compare(diff.path(), diff.oldText(), diff.newText()))
                .filter(change -> change.additions() > 0 || change.deletions() > 0)
                .toList();
        if (!changes.isEmpty()) output.sendEvent("file_changes", ONode.serialize(Map.of("changes", changes)));
    }

    /** A persistent external connection binds a fresh output for each workbench turn. */
    public void bindOutput(AgentOutput output) {
        this.output = output;
        cancelled.set(false);
    }

    public String sessionId() { return sessionId; }

    public void setMode(String modeId) { client.setSessionMode(new SetSessionModeRequest(sessionId, modeId)); }

    private RequestPermissionResponse requestPermission(RequestPermissionRequest request) {
        if (cancelled.get() || (!request.sessionId().equals(sessionId) && !childSessions.containsKey(request.sessionId()))
                || request.options() == null || request.options().isEmpty()) return cancelledPermission();
        String id = UUID.randomUUID().toString();
        String subId = childSessions.containsKey(request.sessionId()) ? request.sessionId()
                : request.toolCall() == null ? null : subToolParents.get(request.toolCall().toolCallId());
        if (subId == null && request.toolCall() != null) {
            String owner = childPermissionTools.get(request.toolCall().toolCallId());
            if (owner != null && !owner.isBlank()) subId = owner;
        }
        Map<String, Object> event = new java.util.LinkedHashMap<>();
        event.put("permissionRequestId", id);
        if (subId != null) event.put("subId", subId);
        event.put("title", request.toolCall().title() == null ? "工具调用需要审批" : request.toolCall().title());
        event.put("description", request.toolCall().rawInput() == null ? "" : ONode.serialize(request.toolCall().rawInput()));
        event.put("options", request.options().stream().map(option -> Map.of("title", option.name(), "value", option.optionId(),
                "kind", option.kind() == null ? "" : option.kind().name().toLowerCase(java.util.Locale.ROOT))).toList());
        PendingPermission pending = new PendingPermission(request.options(), event, new CompletableFuture<>());
        permissions.put(id, pending);
        try {
            if (cancelled.get()) return cancelledPermission();
            output.sendEvent(subId == null ? "choice" : "sub_choice", ONode.serialize(event));
            return pending.answer().join();
        } finally {
            permissions.remove(id);
            var response = pending.answer().getNow(cancelledPermission());
            String selected = response.outcome() instanceof PermissionSelected choice ? choice.optionId() : "cancelled";
            output.sendEvent("permission_resolved", ONode.serialize(Map.of("permissionRequestId", id, "optionId", selected)));
        }
    }

    public void resolvePermission(String id, String optionId) {
        PendingPermission pending = permissions.get(id);
        if (pending == null) throw new ServiceException(409, "审批已结束或不属于当前会话");
        if (pending.options().stream().noneMatch(option -> option.optionId().equals(optionId))) {
            throw new ServiceException("无效的审批选项");
        }
        if (!pending.answer().complete(new RequestPermissionResponse(new PermissionSelected(optionId)))) {
            throw new ServiceException(409, "审批已处理");
        }
    }

    public List<Map<String, Object>> pendingPermissions() {
        return permissions.values().stream().filter(p -> !p.answer().isDone()).map(PendingPermission::event).toList();
    }

    public List<Map<String, Object>> pendingElicitations() { return elicitations.pending(); }
    public void resolveElicitation(String id, String action, Map<String, Object> content) { elicitations.resolve(id, action, content); }

    public void cancel() {
        cancelled.set(true);
        elicitations.cancel();
        permissions.values().forEach(p -> p.answer().complete(cancelledPermission()));
        endActiveSubAgents("aborted");
        if (sessionId != null) {
            try { client.cancel(new CancelNotification(sessionId)); }
            catch (RuntimeException ignored) { /* The Agent may have already exited; local approvals are released. */ }
        }
    }
    @Override public void close() {
        cancelled.set(true);
        elicitations.cancel();
        permissions.values().forEach(p -> p.answer().complete(cancelledPermission()));
        endActiveSubAgents("aborted");
        client.close();
    }
    private static RequestPermissionResponse cancelledPermission() { return new RequestPermissionResponse(new PermissionCancelled()); }
    private static String toolName(String title, Map<String, Object> meta) {
        return meta != null && meta.get("loopra.dev/toolName") instanceof String name ? name
                : title == null ? "unknown" : title;
    }
    private static String toolText(List<ToolCallContent> content) {
        if (content == null) return "";
        return content.stream().filter(ToolCallContentBlock.class::isInstance).map(ToolCallContentBlock.class::cast)
                .map(ToolCallContentBlock::content).filter(TextContent.class::isInstance).map(TextContent.class::cast)
                .map(TextContent::text).collect(java.util.stream.Collectors.joining("\n"));
    }
    private record PendingPermission(List<PermissionOption> options, Map<String, Object> event,
                                     CompletableFuture<RequestPermissionResponse> answer) {}
}
