package site.sorghum.loopra.bin.acp;

import com.agentclientprotocol.sdk.agent.SyncPromptContext;
import com.agentclientprotocol.sdk.annotation.*;
import com.agentclientprotocol.sdk.spec.AcpSchema.*;
import org.noear.snack4.ONode;
import site.sorghum.loopra.bin.agent.model.ChatMessage;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.BiConsumer;

/** The Native engine's ACP v1 server, shared by the workbench and external clients. */
@AcpAgent(name = "loopra", version = "26.9.91")
public final class LoopraAcpAgent {
    private final AcpSessionBackend sessions;
    private volatile boolean workbenchEvents;
    private BiConsumer<String, SessionUpdate> updates;

    public LoopraAcpAgent(AcpSessionBackend sessions) { this.sessions = sessions; }

    public void setUpdateSender(BiConsumer<String, SessionUpdate> updates) { this.updates = updates; }

    @Initialize
    public InitializeResponse initialize(InitializeRequest request) {
        if (request == null || request.protocolVersion() == null || request.protocolVersion() < 1) {
            throw new IllegalArgumentException("ACP protocolVersion must support v1");
        }
        workbenchEvents = request.clientCapabilities() != null && request.clientCapabilities().meta() != null
                && Boolean.TRUE.equals(request.clientCapabilities().meta().get(AcpAgentOutput.EXTENSION));
        return new InitializeResponse(1, new AgentCapabilities(true,
                new SessionCapabilities(Map.of(), Map.of(), null), new McpCapabilities(false, false),
                new PromptCapabilities(false, true, true), null, Map.of(AcpAgentOutput.EXTENSION, true)),
                List.of(), new Implementation("loopra", "26.9.91", "Loopra Native"), null);
    }

    @NewSession
    public NewSessionResponse newSession(NewSessionRequest request) {
        if (request == null || request.cwd() == null) throw new IllegalArgumentException("cwd is required");
        String id = sessions.createSession(request.cwd(), null);
        publishConfig(id);
        return new NewSessionResponse(id, null, null);
    }

    @LoadSession
    public LoadSessionResponse loadSession(LoadSessionRequest request) {
        if (request == null || request.sessionId() == null
                || !sessions.loadOrRestoreSession(request.sessionId(), request.cwd())) {
            throw new IllegalArgumentException("Session not found");
        }
        if (updates != null) replay(request.sessionId());
        publishConfig(request.sessionId());
        return new LoadSessionResponse(null, null);
    }

    @SetSessionConfigOption
    public SetSessionConfigOptionResponse setConfigOption(SetSessionConfigOptionRequest request) {
        if (request == null || request.sessionId() == null) throw new IllegalArgumentException("sessionId is required");
        sessions.setConfigOption(request.sessionId(), request.configId(), request.value());
        return new SetSessionConfigOptionResponse(publishConfig(request.sessionId()));
    }

    @SetSessionMode
    public SetSessionModeResponse setMode(SetSessionModeRequest request) {
        sessions.setConfigOption(request.sessionId(), "mode", request.modeId());
        publishConfig(request.sessionId());
        return new SetSessionModeResponse();
    }

    private List<SessionConfigOption> publishConfig(String id) {
        var config = sessions.configOptions(id);
        if (updates != null && !config.isEmpty()) updates.accept(id, new ConfigOptionUpdate("config_option_update", config));
        return config;
    }

    @ListSessions
    public ListSessionsResponse listSessions() {
        return new ListSessionsResponse(sessions.listSessions().stream()
                .map(s -> new SessionInfo(s.sessionId(), s.cwd())).toList());
    }

    @CloseSession
    public CloseSessionResponse closeSession(CloseSessionRequest request) {
        if (request != null && request.sessionId() != null) sessions.closeSession(request.sessionId());
        return new CloseSessionResponse();
    }

    @Prompt
    public PromptResponse handlePrompt(PromptRequest request, SyncPromptContext context) throws IOException {
        if (request == null || request.sessionId() == null) throw new IllegalArgumentException("sessionId is required");
        AcpAgentOutput output = new AcpAgentOutput(context, workbenchEvents);
        try {
            String reply = sessions.handlePrompt(request.sessionId(), extractText(request), extractImages(request),
                    output, workbenchEvents && request.meta() != null ? request.meta() : Map.of());
            boolean cancelled = sessions.isCancelled(request.sessionId()) || output.isPermissionCancelled();
            publishConfig(request.sessionId());
            if (!cancelled && !output.hasPendingChoice() && reply != null && !reply.isEmpty()) {
                if (workbenchEvents) output.sendEvent("complete", ONode.serialize(Map.of("content", reply)));
                // Commands may return an answer without sending any model chunks.
                else if (!output.hasContent()) output.onContentDelta(reply);
            }
            return new PromptResponse(cancelled ? StopReason.CANCELLED : StopReason.END_TURN);
        } finally {
            output.markCompleted();
        }
    }

    @Cancel
    public void handleCancel(CancelNotification request) {
        if (request != null && request.sessionId() != null) sessions.cancelPrompt(request.sessionId());
    }

    private void replay(String sessionId) {
        for (ChatMessage message : sessions.history(sessionId)) {
            if (message.isWebHidden()) continue;
            if (message.isUser() && message.getContent() != null) {
                updates.accept(sessionId, new UserMessageChunk("user_message_chunk", new TextContent(message.getContent())));
            } else if (message.isAssistant()) {
                if (message.getReasoningContent() != null) updates.accept(sessionId,
                        new AgentThoughtChunk("agent_thought_chunk", new TextContent(message.getReasoningContent())));
                if (message.getContent() != null) updates.accept(sessionId,
                        new AgentMessageChunk("agent_message_chunk", new TextContent(message.getContent())));
                if (message.getToolCalls() != null) for (var call : message.getToolCalls()) {
                    updates.accept(sessionId, new ToolCall("tool_call", call.id(), call.name(), ToolKind.OTHER,
                            ToolCallStatus.PENDING, null, null, call.arguments(), null, null));
                }
            } else if (message.isTool()) {
                updates.accept(sessionId, new ToolCallUpdateNotification("tool_call_update", message.getToolCallId(),
                        null, null, ToolCallStatus.COMPLETED, List.of(new ToolCallContentBlock("content",
                        new TextContent(message.getContent() == null ? "" : message.getContent()))),
                        null, null, message.getContent(), null));
            }
        }
    }

    private String extractText(PromptRequest request) {
        StringBuilder text = new StringBuilder();
        if (request.prompt() == null) return "";
        for (ContentBlock block : request.prompt()) {
            String value = null;
            if (block instanceof TextContent content) value = content.text();
            else if (block instanceof Resource resource && resource.resource() instanceof TextResourceContents content) {
                value = (content.uri() == null ? "" : "[文件: " + content.uri() + "]\n") + content.text();
            } else if (block instanceof ResourceLink link) value = "[文件: " + link.uri() + "]";
            if (value != null) { if (!text.isEmpty()) text.append('\n'); text.append(value); }
        }
        return text.toString();
    }

    private List<String> extractImages(PromptRequest request) {
        List<String> images = new ArrayList<>();
        if (request.prompt() != null) for (ContentBlock block : request.prompt()) {
            if (block instanceof ImageContent image) {
                if (image.data() != null && !image.data().isEmpty()) images.add("data:"
                        + (image.mimeType() == null ? "image/png" : image.mimeType()) + ";base64," + image.data());
                else if (image.uri() != null) images.add(image.uri());
            }
        }
        return images;
    }
}
