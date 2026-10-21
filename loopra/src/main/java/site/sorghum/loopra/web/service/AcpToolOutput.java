package site.sorghum.loopra.web.service;

import com.agentclientprotocol.sdk.spec.AcpSchema.*;
import org.noear.snack4.ONode;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/** Retains partial ACP results until a tool's status-only completion arrives. */
final class AcpToolOutput {
    private final StringBuilder terminal = new StringBuilder();
    private final StringBuilder progress = new StringBuilder();
    private Object rawOutput;
    private String content = "";
    private Integer exitCode;
    private String signal;

    synchronized void update(Object raw, List<ToolCallContent> blocks, Map<String, Object> meta) {
        if (raw != null) {
            rawOutput = raw;
            if (raw instanceof Map<?, ?> value) readExit(value);
        }
        if (blocks != null) {
            content = blocks.stream().filter(ToolCallContentBlock.class::isInstance)
                    .map(ToolCallContentBlock.class::cast).map(ToolCallContentBlock::content)
                    .filter(TextContent.class::isInstance).map(TextContent.class::cast)
                    .map(TextContent::text).collect(Collectors.joining("\n"));
        }
        if (meta == null) return;
        // Both adapter conventions carry append-only chunks; prefer the explicit
        // delta if a peer supplies both aliases in the same notification.
        String chunk = data(meta.get("terminal_output_delta"));
        if (chunk == null) chunk = data(meta.get("terminal_output"));
        if (chunk != null) terminal.append(chunk);
        String mcp = data(meta.get("mcp_output_delta"));
        if (mcp != null) progress.append(mcp);
        if (meta.get("terminal_exit") instanceof Map<?, ?> value) readExit(value);
    }

    synchronized String text() {
        boolean exitOnly = rawOutput instanceof Map<?, ?> value
                && value.keySet().stream().allMatch(key -> "exit_code".equals(key) || "signal".equals(key));
        String body;
        if (!terminal.isEmpty()) body = terminal.toString();
        else if (rawOutput != null && !exitOnly && !(rawOutput instanceof String text && text.isEmpty()))
            body = rawOutput instanceof String text ? text : ONode.serialize(rawOutput);
        else if (!content.isEmpty()) body = content;
        else body = progress.toString();
        if (exitCode == null && signal == null) return body;
        String summary = (exitCode == null ? "" : "Exit code: " + exitCode)
                + (signal == null ? "" : (exitCode == null ? "" : ", ") + "Signal: " + signal);
        return body.isEmpty() ? summary : body + (body.endsWith("\n") ? "\n" : "\n\n") + summary;
    }

    synchronized boolean failed() {
        return (exitCode != null && exitCode != 0) || signal != null;
    }

    private void readExit(Map<?, ?> value) {
        if (value.get("exit_code") instanceof Number code) exitCode = code.intValue();
        if (value.get("signal") instanceof String text && !text.isBlank()) signal = text;
    }

    private static String data(Object value) {
        return value instanceof Map<?, ?> chunk && chunk.get("data") instanceof String text ? text : null;
    }
}
