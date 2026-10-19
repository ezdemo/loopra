package site.sorghum.loopra.web.service;

import org.noear.snack4.ONode;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.model.FileChange;
import site.sorghum.loopra.bin.agent.model.ToolCallEntry;
import site.sorghum.loopra.bin.session.SessionStore;
import site.sorghum.loopra.tool.AgentOutput;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.ArrayList;
import java.util.List;

/** Workbench transcript only. The external Agent owns its model context and resume data. */
final class AcpTranscriptOutput implements AgentOutput {
    private final AgentOutput delegate;
    private final SessionStore store;
    private final StringBuilder text = new StringBuilder();
    private final StringBuilder thought = new StringBuilder();
    private final java.util.Map<String, ToolCallEntry> tools = new java.util.LinkedHashMap<>();
    private boolean toolsUpdated;

    AcpTranscriptOutput(AgentOutput delegate, SessionStore store) { this.delegate = delegate; this.store = store; }

    @Override public synchronized void onContentDelta(String token) { text.append(token); delegate.onContentDelta(token); }
    @Override public synchronized void onReasoningDelta(String token) { thought.append(token); delegate.onReasoningDelta(token); }
    @Override public synchronized void onToolCall(String id, String name, String args) {
        flush();
        append(ChatMessage.assistant(null, List.of(new ToolCallEntry(id, name, args)), null));
        tools.put(id, new ToolCallEntry(id, name, args));
        delegate.onToolCall(id, name, args);
    }
    @Override public synchronized void onToolUpdate(String id, String name, String args) {
        ToolCallEntry previous = tools.get(id);
        if (previous != null) {
            tools.put(id, new ToolCallEntry(id, name, args == null ? previous.arguments() : args));
            toolsUpdated = true;
        }
        delegate.onToolUpdate(id, name, args);
    }
    @Override public synchronized void onToolResult(String id, String name, String result, boolean failed) {
        flush();
        append(ChatMessage.tool(id, failed ? "[failed] " + result : result));
        delegate.onToolResult(id, name, result, failed);
    }
    @Override public synchronized void sendEvent(String type, String data) {
        if ("file_changes".equals(type)) persistFileChanges(data);
        delegate.sendEvent(type, data);
    }

    /**
     * File-change summaries are normally attached to a Native assistant message.
     * ACP reports them as events, so store an assistant entry that the history
     * loader turns back into the same `file_changes` block.
     */
    private void persistFileChanges(String data) {
        ONode root = ONode.ofJson(data);
        if (!root.get("changes").isArray()) return;
        List<FileChange> changes = new ArrayList<>();
        for (ONode item : root.get("changes").getArray()) {
            String path = item.get("path").getString();
            if (path == null || path.isBlank()) continue;
            changes.add(new FileChange(path, item.get("additions").getInt(), item.get("deletions").getInt(),
                    item.get("created").getBoolean(), item.get("diff").getString()));
        }
        if (changes.isEmpty()) return;
        flush();
        ChatMessage message = ChatMessage.assistant(null, null, null);
        message.setFileChanges(changes);
        append(message);
        store.flush();
    }
    @Override public void onContentComplete() { delegate.onContentComplete(); }
    @Override public void onReasoning(String value) { onReasoningDelta(value); }
    @Override public void onToolCall(String name, String args) { delegate.onToolCall(name, args); }
    @Override public void onToolResult(String name, String value) { delegate.onToolResult(name, value); }
    @Override public void onUsage(int p, int c, int t, int h, int m) { delegate.onUsage(p, c, t, h, m); }
    @Override public void onError(String error) { delegate.onError(error); }
    @Override public void onLog(site.sorghum.loopra.tool.LogLevel level, String message) { delegate.onLog(level, message); }
    @Override public void onChoice(List<site.sorghum.loopra.tool.ChoiceOption> options) { delegate.onChoice(options); }
    synchronized void flush() {
        if (!text.isEmpty() || !thought.isEmpty()) {
            append(ChatMessage.assistant(text.toString(), null, thought.toString()));
            text.setLength(0); thought.setLength(0);
        }
        store.flush();
    }
    synchronized void finish() {
        flush();
        if (!toolsUpdated) return;
        try {
            var history = store.load();
            history.forEach(message -> {
                if (message.getToolCalls() != null) message.setToolCalls(message.getToolCalls().stream()
                        .map(call -> tools.getOrDefault(call.id(), call)).toList());
            });
            store.rewrite(history);
        } catch (IOException e) { throw new UncheckedIOException(e); }
    }
    private void append(ChatMessage message) {
        try { store.append(message); } catch (IOException e) { throw new UncheckedIOException(e); }
    }
}
