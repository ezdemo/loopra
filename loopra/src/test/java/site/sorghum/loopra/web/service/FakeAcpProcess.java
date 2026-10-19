package site.sorghum.loopra.web.service;

import org.noear.snack4.ONode;
import java.util.*;

/** Deterministic external stdio peer; no credentials, user files or model calls. */
public final class FakeAcpProcess {
    private static String model = "alpha", mode = "default";
    private static List<String> directories = List.of();
    public static void main(String[] args) {
        Scanner input = new Scanner(System.in, java.nio.charset.StandardCharsets.UTF_8);
        Object promptId = null;
        while (input.hasNextLine()) {
            ONode message = ONode.ofJson(input.nextLine());
            String method = message.get("method").getString();
            Object id = message.get("id").getValue();
            if (method == null) {
                if (promptId == null) continue;
                String outcome = message.get("result").get("outcome").get("optionId").getString();
                update(Map.of("sessionUpdate", "tool_call_update", "toolCallId", "call-1", "status",
                        "allow".equals(outcome) ? "completed" : "failed", "rawOutput", "result:" + outcome));
                update(Map.of("sessionUpdate", "agent_message_chunk", "content", Map.of("type", "text", "text", "answered")));
                response(promptId, Map.of("stopReason", "end_turn")); promptId = null;
                continue;
            }
            switch (method) {
                case "initialize" -> response(id, Map.of("protocolVersion", 1,
                        "agentCapabilities", Map.of("loadSession", true, "additionalDirectories", true)));
                case "session/new" -> {
                    directories = readDirectories(message);
                    response(id, Map.of("sessionId", "fake-session", "configOptions", config()));
                }
                case "session/load" -> {
                    directories = readDirectories(message);
                    update(Map.of("sessionUpdate", "agent_message_chunk", "content", Map.of("type", "text", "text", "OLD REPLAY")));
                    response(id, Map.of("configOptions", config()));
                }
                case "session/set_mode" -> response(id, Map.of());
                case "session/set_config_option" -> {
                    String configId = message.get("params").get("configId").getString();
                    String value = message.get("params").get("value").getString();
                    if ("fail".equals(value)) {
                        send(Map.of("jsonrpc", "2.0", "id", id, "error", Map.of("code", -32602, "message", "not available")));
                        continue;
                    }
                    if ("model".equals(configId)) model = value;
                    if ("mode".equals(configId)) mode = value;
                    update(Map.of("sessionUpdate", "config_option_update", "configOptions", config()));
                    response(id, Map.of("configOptions", config()));
                }
                case "session/prompt" -> {
                    String text = message.get("params").get("prompt").get(0).get("text").getString();
                    if ("exit".equals(text)) System.exit(0);
                    if (text.contains("agent-switch")) {
                        // Simulates a permission-mode change initiated by the Agent itself
                        // (e.g. plan approval), i.e. not via session/set_config_option.
                        mode = "plan";
                        update(Map.of("sessionUpdate", "config_option_update", "configOptions", config()));
                        response(id, Map.of("stopReason", "end_turn"));
                        continue;
                    }
                    if (text.contains("echo-linked")) {
                        update(Map.of("sessionUpdate", "agent_message_chunk", "content", Map.of("type", "text",
                                "text", "reply-linked:" + text.contains("本轮关联项目") + ":" + String.join(",", directories))));
                        response(id, Map.of("stopReason", "end_turn"));
                        continue;
                    }
                    if ("permission".equals(text)) {
                        promptId = id;
                        update(Map.of("sessionUpdate", "tool_call", "toolCallId", "call-1", "title", "Write test file",
                                "status", "pending", "rawInput", Map.of("path", "example.txt")));
                        update(Map.of("sessionUpdate", "tool_call_update", "toolCallId", "call-1", "title", "Write example.txt",
                                "rawInput", Map.of("path", "example.txt", "content", "final arguments")));
                        send(Map.of("jsonrpc", "2.0", "id", "approval", "method", "session/request_permission", "params", Map.of(
                                "sessionId", "fake-session", "toolCall", Map.of("toolCallId", "call-1", "title", "Write test file"),
                                "options", List.of(Map.of("optionId", "allow", "name", "Allow once", "kind", "allow_once"),
                                        Map.of("optionId", "deny", "name", "Reject", "kind", "reject_once")))));
                    } else if ("edit".equals(text)) {
                        // ACP exposes edit changes as `diff` content, like the Claude adapter.
                        update(Map.of("sessionUpdate", "tool_call", "toolCallId", "edit-1", "title", "Edit example.txt",
                                "kind", "edit", "status", "pending", "content", List.of(Map.of("type", "diff",
                                        "path", "example.txt", "oldText", "old line\n", "newText", "new line\n"))));
                        update(Map.of("sessionUpdate", "tool_call_update", "toolCallId", "edit-1", "status", "completed",
                                "rawOutput", "edited"));
                        update(Map.of("sessionUpdate", "agent_message_chunk", "content", Map.of("type", "text", "text", "edited")));
                        response(id, Map.of("stopReason", "end_turn"));
                    } else {
                        update(Map.of("sessionUpdate", "agent_message_chunk", "content", Map.of("type", "text", "text", "reply:" + text
                                + ("state".equals(text) ? ":" + model + ":" + mode : ""))));
                        // Real adapters report the context window in an unstable ACP update;
                        // later compaction updates may omit cost and model.
                        update(Map.of("sessionUpdate", "usage_update", "used", 3210, "size", 200000,
                                "cost", Map.of("amount", 0.0456, "currency", "USD"),
                                "_meta", Map.of("_claude/model", "claude-test")));
                        response(id, Map.of("stopReason", "end_turn"));
                    }
                }
                case "session/cancel" -> {
                    if (promptId != null) { response(promptId, Map.of("stopReason", "cancelled")); promptId = null; }
                }
                default -> response(id, Map.of());
            }
        }
    }
    private static List<String> readDirectories(ONode message) {
        Object raw = message.get("params").get("additionalDirectories").getValue();
        if (!(raw instanceof List<?> list)) return List.of();
        List<String> values = new ArrayList<>();
        for (Object item : list) {
            if (item == null) continue;
            values.add(item instanceof ONode node ? node.getString() : String.valueOf(item));
        }
        return values;
    }
    private static List<Map<String, Object>> config() {
        return List.of(Map.of("id", "model", "name", "Model", "category", "model", "type", "select", "currentValue", model,
                        "options", List.of(Map.of("group", "custom", "name", "Custom models", "options",
                                List.of(Map.of("value", "alpha", "name", "Alpha"), Map.of("value", "beta", "name", "Beta"))))),
                Map.of("id", "mode", "name", "Permission", "category", "mode", "type", "select", "currentValue", mode,
                        "options", List.of(Map.of("value", "default", "name", "Default"), Map.of("value", "plan", "name", "Plan"), Map.of("value", "fail", "name", "Unavailable"))),
                Map.of("id", "future", "name", "Future", "type", "unknown_future_type", "currentValue", 4));
    }
    private static void update(Map<String, Object> update) {
        send(Map.of("jsonrpc", "2.0", "method", "session/update", "params", Map.of("sessionId", "fake-session", "update", update)));
    }
    private static void response(Object id, Object result) { send(Map.of("jsonrpc", "2.0", "id", id, "result", result)); }
    private static void send(Object value) { System.out.println(ONode.serialize(value)); System.out.flush(); }
}
