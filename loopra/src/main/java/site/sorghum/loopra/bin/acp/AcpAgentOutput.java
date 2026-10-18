package site.sorghum.loopra.bin.acp;

import com.agentclientprotocol.sdk.agent.SyncPromptContext;
import com.agentclientprotocol.sdk.spec.AcpSchema.*;
import org.noear.snack4.ONode;
import site.sorghum.loopra.tool.AgentOutput;
import site.sorghum.loopra.tool.ChoiceOption;
import site.sorghum.loopra.tool.LogLevel;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/** ACP v1 updates, with negotiated metadata for Native workbench features. */
public final class AcpAgentOutput implements AgentOutput {
    public static final String EXTENSION = "loopra.dev/workbench";
    public static final String EVENT = "loopra.dev/event";
    private final SyncPromptContext context;
    private final boolean workbenchEvents;
    private final Map<String, String> activeTools = new ConcurrentHashMap<>();
    private final CompletableFuture<Void> completion = new CompletableFuture<>();
    private volatile boolean completed;
    private volatile Boolean permissionDecision;
    private volatile boolean pendingChoice;
    private volatile boolean permissionCancelled;
    private volatile boolean contentSent;

    public AcpAgentOutput(SyncPromptContext context, boolean workbenchEvents) {
        this.context = context;
        this.workbenchEvents = workbenchEvents;
    }

    @Override public synchronized void onContentDelta(String text) {
        if (!completed && text != null && !text.isEmpty()) { contentSent = true; context.sendMessage(text); }
    }
    @Override public void onContentComplete() {}
    @Override public synchronized void onReasoningDelta(String text) {
        if (!completed && text != null && !text.isEmpty()) context.sendThought(text);
    }
    @Override public void onReasoning(String text) { onReasoningDelta(text); }
    @Override public void onReasoningStarted() { sendEvent("reasoning_started", "{}"); }

    @Override public void onToolCall(String name, String args) {
        onToolCall(UUID.randomUUID().toString(), name, args);
    }
    @Override public synchronized void onToolCall(String id, String name, String args) {
        if (completed) return;
        if (id == null || id.isBlank()) id = UUID.randomUUID().toString();
        activeTools.put(id, name);
        context.sendUpdate(context.getSessionId(), new ToolCall("tool_call", id, name,
                ToolKind.OTHER, ToolCallStatus.IN_PROGRESS, null, null, parse(args), null,
                Map.of("loopra.dev/toolName", name)));
    }
    @Override public void onToolResult(String name, String result) {
        String id = activeTools.entrySet().stream().filter(e -> e.getValue().equals(name))
                .map(Map.Entry::getKey).findFirst().orElse(UUID.randomUUID().toString());
        onToolResult(id, name, result, false);
    }
    @Override public synchronized void onToolResult(String id, String name, String result, boolean failed) {
        if (completed) return;
        activeTools.remove(id);
        context.sendUpdate(context.getSessionId(), new ToolCallUpdateNotification("tool_call_update", id,
                name, null, failed ? ToolCallStatus.FAILED : ToolCallStatus.COMPLETED,
                List.of(new ToolCallContentBlock("content", new TextContent(result == null ? "" : result))),
                null, null, result, Map.of("loopra.dev/toolName", name)));
    }
    @Override public void onUsage(int prompt, int generated, int total, int hit, int miss) {
        sendEvent("usage", ONode.serialize(Map.of("promptTokens", prompt, "completionTokens", generated,
                "totalTokens", total, "cacheHit", hit, "cacheMiss", miss, "lastPromptTokens", prompt)));
    }
    @Override public void onError(String error) {
        if (workbenchEvents) sendEvent("error", ONode.serialize(Map.of("error", error == null ? "" : error)));
        else onContentDelta("错误: " + error);
    }
    @Override public void onLog(LogLevel level, String message) {
        sendEvent("log", ONode.serialize(Map.of("level", level.name(), "message", message)));
    }
    @Override public void onChoice(List<ChoiceOption> options) { onChoice(options, null, null); }
    @Override public void onChoice(List<ChoiceOption> options, String title, String description) {
        if (options == null || options.isEmpty() || completed) return;
        boolean approval = options.stream().anyMatch(o -> "/agree".equals(o.value()))
                && options.stream().anyMatch(o -> "/deny".equals(o.value()));
        if (!approval) {
            pendingChoice = true;
            ONode event = ONode.ofJson("{}").set("options", options);
            if (title != null) event.set("title", title);
            if (description != null) event.set("description", description);
            if (workbenchEvents) sendEvent("choice", event.toJson());
            else onContentDelta((title == null ? "请选择" : title) + "\n"
                    + options.stream().map(o -> o.title() + " (" + o.value() + ")")
                    .collect(java.util.stream.Collectors.joining("\n")));
            return;
        }
        List<PermissionOption> permissions = options.stream().map(o -> new PermissionOption(o.value(), o.title(),
                "/agree".equals(o.value()) ? PermissionOptionKind.ALLOW_ONCE : PermissionOptionKind.REJECT_ONCE)).toList();
        String details = title == null ? "工具调用需要审批" : title;
        if (description != null) details += "\n" + description;
        RequestPermissionResponse response = context.requestPermission(new RequestPermissionRequest(
                context.getSessionId(), new ToolCallUpdate("approval-" + UUID.randomUUID(), details,
                ToolKind.OTHER, ToolCallStatus.PENDING, null, null, null, null), permissions));
        permissionDecision = response != null && response.outcome() instanceof PermissionSelected selected
                ? "/agree".equals(selected.optionId()) : null;
        permissionCancelled = permissionDecision == null;
    }
    public Boolean takePermissionDecision() {
        Boolean decision = permissionDecision;
        permissionDecision = null;
        return decision;
    }
    public boolean hasPendingChoice() { return pendingChoice; }
    public boolean isPermissionCancelled() { return permissionCancelled; }
    public boolean hasContent() { return contentSent; }

    @Override public synchronized void sendEvent(String type, String data) {
        if (!completed && workbenchEvents && type != null && data != null) {
            context.sendUpdate(context.getSessionId(), new AgentMessageChunk("agent_message_chunk",
                    new TextContent(""), null, Map.of(EVENT, Map.of("type", type, "data", data))));
        }
    }
    public synchronized void markCompleted() {
        if (completed) return;
        for (var entry : Map.copyOf(activeTools).entrySet()) {
            onToolResult(entry.getKey(), entry.getValue(), "工具执行已结束，未收到结果", true);
        }
        completed = true;
        completion.complete(null);
    }
    public boolean awaitCompletion(long timeoutMs) {
        try { completion.get(timeoutMs, TimeUnit.MILLISECONDS); return true; }
        catch (InterruptedException e) { Thread.currentThread().interrupt(); return false; }
        catch (Exception e) { return false; }
    }
    private static Object parse(String value) {
        try { return value == null ? null : ONode.ofJson(value).toData(); }
        catch (Exception ignored) { return value; }
    }
}
