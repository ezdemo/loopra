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
    private final AgentOutput output;
    private final AtomicBoolean cancelled = new AtomicBoolean();
    private final Map<String, PendingPermission> permissions = new ConcurrentHashMap<>();
    private final Map<String, String> toolNames = new ConcurrentHashMap<>();
    private volatile String sessionId;
    private volatile boolean nativeEvents;

    public AcpWorkbenchClient(AcpClientTransport transport, AgentOutput output) {
        this.output = output;
        client = AcpClient.sync(transport).requestTimeout(Duration.ofHours(12))
                .notificationHandler(AcpSchema.METHOD_SESSION_UPDATE, params -> Mono.fromRunnable(() ->
                        accept(transport.unmarshalFrom(params, new TypeRef<SessionNotification>() {}))))
                .requestPermissionHandler(this::requestPermission).build();
    }

    public String open(String cwd) {
        InitializeResponse initialized = client.initialize(new InitializeRequest(1,
                new ClientCapabilities(new FileSystemCapability(false, false), false, null,
                        Map.of(AcpAgentOutput.EXTENSION, true)),
                new Implementation("loopra-workbench", "26.9.91", "Loopra Workbench"), null));
        if (initialized.protocolVersion() == null || initialized.protocolVersion() != 1) {
            throw new IllegalStateException("Agent did not negotiate ACP v1");
        }
        nativeEvents = initialized.agentCapabilities() != null && initialized.agentCapabilities().meta() != null
                && Boolean.TRUE.equals(initialized.agentCapabilities().meta().get(AcpAgentOutput.EXTENSION));
        sessionId = client.newSession(new NewSessionRequest(cwd, List.of())).sessionId();
        if (sessionId == null || sessionId.isBlank()) throw new IllegalStateException("Agent returned an empty session ID");
        return sessionId;
    }

    public PromptResponse prompt(UserMessage message, Map<String, Object> options) {
        if (cancelled.get()) return new PromptResponse(StopReason.CANCELLED);
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
        } else if (update instanceof ToolCallUpdateNotification call) {
            String name = toolNames.getOrDefault(call.toolCallId(), toolName(call.title(), call.meta()));
            if (call.status() == ToolCallStatus.COMPLETED || call.status() == ToolCallStatus.FAILED) {
                String result = call.rawOutput() instanceof String value ? value
                        : call.rawOutput() != null ? ONode.serialize(call.rawOutput()) : toolText(call.content());
                output.onToolResult(call.toolCallId(), name, result, call.status() == ToolCallStatus.FAILED);
            }
        }
    }

    private RequestPermissionResponse requestPermission(RequestPermissionRequest request) {
        if (cancelled.get() || !request.sessionId().equals(sessionId)
                || request.options() == null || request.options().isEmpty()) return cancelledPermission();
        String id = UUID.randomUUID().toString();
        Map<String, Object> event = Map.of("permissionRequestId", id,
                "title", request.toolCall().title() == null ? "工具调用需要审批" : request.toolCall().title(),
                "options", request.options().stream().map(option -> Map.of("title", option.name(), "value", option.optionId())).toList());
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
        if (sessionId != null) client.cancel(new CancelNotification(sessionId));
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
