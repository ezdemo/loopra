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
import site.sorghum.loopra.bin.agent.model.UserMessage;
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
    private final AcpSyncClient client;
    private volatile AgentOutput output;
    private final AtomicBoolean cancelled = new AtomicBoolean();
    private final Map<String, PendingPermission> permissions = new ConcurrentHashMap<>();
    private final Map<String, String> toolNames = new ConcurrentHashMap<>();
    private volatile String sessionId;
    private volatile boolean nativeEvents;
    private volatile boolean replaying;
    private InitializeResponse initialized;
    private volatile List<AcpConfigOption> configuration = List.of();
    private volatile boolean configOptionsSupported;
    /** Optional owner hook so persistent sessions can save Agent-originated changes. */
    private volatile java.util.function.Consumer<List<AcpConfigOption>> configListener;

    public AcpWorkbenchClient(AcpClientTransport transport, AgentOutput output) {
        this.output = output;
        AcpClientTransport observed = new AcpClientTransport() {
            public Mono<Void> connect(java.util.function.Function<Mono<JSONRPCMessage>, Mono<JSONRPCMessage>> handler) {
                return transport.connect(message -> handler.apply(message.map(AcpWorkbenchClient.this::observeResponse)));
            }
            public Mono<Void> sendMessage(JSONRPCMessage message) { return transport.sendMessage(message); }
            public <T> T unmarshalFrom(Object data, TypeRef<T> type) { return transport.unmarshalFrom(data, type); }
            public Mono<Void> closeGracefully() { return transport.closeGracefully(); }
            public void setExceptionHandler(java.util.function.Consumer<Throwable> handler) { transport.setExceptionHandler(handler); }
        };
        client = AcpClient.sync(observed).requestTimeout(Duration.ofHours(12))
                .notificationHandler(AcpSchema.METHOD_SESSION_UPDATE, params -> Mono.fromRunnable(() -> {
                    Map<String, Object> raw = transport.unmarshalFrom(params, new TypeRef<Map<String, Object>>() {});
                    if (sessionId != null && !sessionId.equals(raw.get("sessionId"))) return;
                    if (raw.get("update") instanceof Map<?, ?> update && "config_option_update".equals(update.get("sessionUpdate"))) {
                        updateConfiguration(update.get("configOptions"));
                    } else accept(transport.unmarshalFrom(params, new TypeRef<SessionNotification>() {}));
                }))
                .requestPermissionHandler(this::requestPermission).build();
    }

    /** SDK 0.14 omits setup configOptions and cannot decode grouped/unknown option variants. */
    private JSONRPCMessage observeResponse(JSONRPCMessage message) {
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
        List<String> directories = additionalDirectories == null ? List.of() : List.copyOf(additionalDirectories);
        initialized = client.initialize(new InitializeRequest(1,
                new ClientCapabilities(new FileSystemCapability(false, false), false, null,
                        Map.of(AcpAgentOutput.EXTENSION, true)),
                new Implementation("loopra-workbench", "26.9.91", "Loopra Workbench"), null));
        if (initialized.protocolVersion() == null || initialized.protocolVersion() != 1) {
            throw new IllegalStateException("Agent did not negotiate ACP v1");
        }
        nativeEvents = initialized.agentCapabilities() != null && initialized.agentCapabilities().meta() != null
                && Boolean.TRUE.equals(initialized.agentCapabilities().meta().get(AcpAgentOutput.EXTENSION));
        if (existingSessionId != null) {
            if (initialized.agentCapabilities() == null || !Boolean.TRUE.equals(initialized.agentCapabilities().loadSession())) {
                throw new IllegalStateException("Agent 不支持恢复会话，请创建新会话");
            }
            sessionId = existingSessionId;
            replaying = true;
            try {
                var loaded = client.loadSession(new LoadSessionRequest(existingSessionId, cwd, List.of(), directories));
                legacyConfiguration(loaded.modes(), loaded.models());
            }
            finally { replaying = false; }
        } else {
            var created = client.newSession(new NewSessionRequest(cwd, List.of(), directories));
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
        toolNames.clear();
        List<ContentBlock> blocks = new ArrayList<>();
        if (message.getText() != null) blocks.add(new TextContent(message.getText()));
        for (String image : message.getImages()) {
            int comma = image.indexOf(',');
            if (image.startsWith("data:") && comma > 0 && image.substring(0, comma).endsWith(";base64")) {
                blocks.add(new ImageContent("image", image.substring(comma + 1),
                        image.substring(5, image.indexOf(';')), null, null, null));
            } else blocks.add(new ImageContent("image", null, null, image, null, null));
        }
        return client.prompt(new PromptRequest(sessionId, blocks, nativeEvents ? options : null));
    }

    private void accept(SessionNotification notification) {
        if (replaying) return;
        if (sessionId != null && !sessionId.equals(notification.sessionId())) return;
        var update = notification.update();
        if (update instanceof AgentMessageChunk chunk) {
            if (nativeEvents && chunk.meta() != null && chunk.meta().get(AcpAgentOutput.EVENT) instanceof Map<?, ?> event) {
                output.sendEvent(String.valueOf(event.get("type")), String.valueOf(event.get("data")));
            } else if (chunk.content() instanceof TextContent text) output.onContentDelta(text.text());
        } else if (update instanceof AgentThoughtChunk chunk && chunk.content() instanceof TextContent text) {
            output.onReasoningDelta(text.text());
        } else if (update instanceof ToolCall call) {
            String name = toolName(call.title(), call.meta());
            toolNames.put(call.toolCallId(), name);
            output.onToolCall(call.toolCallId(), name, ONode.serialize(call.rawInput()));
            finishTool(call.toolCallId(), name, call.status(), call.rawOutput(), call.content());
        } else if (update instanceof ToolCallUpdateNotification call) {
            String name = call.title() == null ? toolNames.getOrDefault(call.toolCallId(), "unknown")
                    : toolName(call.title(), call.meta());
            toolNames.put(call.toolCallId(), name);
            if (call.rawInput() != null || call.title() != null) {
                output.onToolUpdate(call.toolCallId(), name, call.rawInput() == null ? null : ONode.serialize(call.rawInput()));
            }
            finishTool(call.toolCallId(), name, call.status(), call.rawOutput(), call.content());
        }
    }

    private void finishTool(String id, String name, ToolCallStatus status, Object raw, List<ToolCallContent> content) {
        if (status != ToolCallStatus.COMPLETED && status != ToolCallStatus.FAILED) return;
        String result = raw instanceof String value ? value : raw != null ? ONode.serialize(raw) : toolText(content);
        output.onToolResult(id, name, result, status == ToolCallStatus.FAILED);
    }

    /** A persistent external connection binds a fresh output for each workbench turn. */
    public void bindOutput(AgentOutput output) {
        this.output = output;
        cancelled.set(false);
    }

    public String sessionId() { return sessionId; }

    public void setMode(String modeId) { client.setSessionMode(new SetSessionModeRequest(sessionId, modeId)); }

    private RequestPermissionResponse requestPermission(RequestPermissionRequest request) {
        if (cancelled.get() || !request.sessionId().equals(sessionId)
                || request.options() == null || request.options().isEmpty()) return cancelledPermission();
        String id = UUID.randomUUID().toString();
        Map<String, Object> event = Map.of("permissionRequestId", id,
                "title", request.toolCall().title() == null ? "工具调用需要审批" : request.toolCall().title(),
                "description", request.toolCall().rawInput() == null ? "" : ONode.serialize(request.toolCall().rawInput()),
                "options", request.options().stream().map(option -> Map.of("title", option.name(), "value", option.optionId(),
                        "kind", option.kind() == null ? "" : option.kind().name().toLowerCase(java.util.Locale.ROOT))).toList());
        PendingPermission pending = new PendingPermission(request.options(), event, new CompletableFuture<>());
        permissions.put(id, pending);
        try {
            if (cancelled.get()) return cancelledPermission();
            output.sendEvent("choice", ONode.serialize(event));
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

    public void cancel() {
        cancelled.set(true);
        permissions.values().forEach(p -> p.answer().complete(cancelledPermission()));
        if (sessionId != null) {
            try { client.cancel(new CancelNotification(sessionId)); }
            catch (RuntimeException ignored) { /* The Agent may have already exited; local approvals are released. */ }
        }
    }
    @Override public void close() {
        cancelled.set(true);
        permissions.values().forEach(p -> p.answer().complete(cancelledPermission()));
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
