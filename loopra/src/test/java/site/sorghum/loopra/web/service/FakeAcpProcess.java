package site.sorghum.loopra.web.service;

import org.noear.snack4.ONode;
import java.util.*;

/** Deterministic external stdio peer; no credentials, user files or model calls. */
public final class FakeAcpProcess {
    private static String model = "alpha", mode = "default";
    private static List<String> directories = List.of();
    private static String mcp = "[]";
    private static String setup = "new";
    private static boolean nativeChildren;
    private static String permissionChild;
    private static boolean forms;
    private static boolean answeringInput;
    public static void main(String[] args) {
        Scanner input = new Scanner(System.in, java.nio.charset.StandardCharsets.UTF_8);
        Object promptId = null;
        while (input.hasNextLine()) {
            ONode message = ONode.ofJson(input.nextLine());
            String method = message.get("method").getString();
            Object id = message.get("id").getValue();
            if (method == null) {
                if (promptId == null) continue;
                if (answeringInput) {
                    update(Map.of("sessionUpdate", "agent_message_chunk", "content", Map.of("type", "text", "text", "input:" + message.get("result").toJson())));
                    response(promptId, Map.of("stopReason", "end_turn"));
                    promptId = null; answeringInput = false;
                    continue;
                }
                String outcome = message.get("result").get("outcome").get("optionId").getString();
                if (permissionChild != null) {
                    childUpdate(permissionChild, Map.of("sessionUpdate", "tool_call_update", "toolCallId", "child-permission",
                            "status", "allow".equals(outcome) ? "completed" : "failed", "rawOutput", "result:" + outcome));
                    endChild("fake-session", permissionChild, "completed");
                    response(promptId, Map.of("stopReason", "end_turn"));
                    promptId = null; permissionChild = null;
                    continue;
                }
                update(Map.of("sessionUpdate", "tool_call_update", "toolCallId", "call-1", "status",
                        "allow".equals(outcome) ? "completed" : "failed", "rawOutput", "result:" + outcome));
                update(Map.of("sessionUpdate", "agent_message_chunk", "content", Map.of("type", "text", "text", "answered")));
                response(promptId, Map.of("stopReason", "end_turn")); promptId = null;
                continue;
            }
            switch (method) {
                case "initialize" -> {
                    forms = message.get("params").get("clientCapabilities").get("elicitation").get("form").isObject();
                    nativeChildren = message.get("params").get("clientCapabilities").get("subagents").isObject()
                            && !Boolean.getBoolean("loopra.fake.noSubagents");
                    response(id, Map.of("protocolVersion", 1,
                        "agentCapabilities", Map.of("loadSession", true, "additionalDirectories", true,
                                "sessionCapabilities", nativeChildren ? Map.of("subagents", Map.of()) : Map.of(),
                                "mcpCapabilities", Map.of("http", true, "sse", true))));
                }
                case "session/new" -> {
                    // Tests use this to keep a configuration request inside session setup,
                    // which is where a real Agent spawns its process and restores a session.
                    long openDelay = Long.getLong("loopra.fake.sessionNewDelay", 0L);
                    String marker = System.getProperty("loopra.fake.sessionNewMarker");
                    if (marker != null) {
                        try { java.nio.file.Files.writeString(java.nio.file.Path.of(marker), "opening"); }
                        catch (java.io.IOException ignored) { /* Marker is best effort. */ }
                    }
                    if (openDelay > 0) {
                        try { Thread.sleep(openDelay); }
                        catch (InterruptedException e) { Thread.currentThread().interrupt(); }
                    }
                    directories = readDirectories(message);
                    mcp = message.get("params").get("mcpServers").toJson();
                    setup = "new";
                    response(id, Map.of("sessionId", "fake-session", "configOptions", config()));
                }
                case "session/load" -> {
                    mcp = message.get("params").get("mcpServers").toJson();
                    setup = "load";
                    directories = readDirectories(message);
                    update(Map.of("sessionUpdate", "agent_message_chunk", "content", Map.of("type", "text", "text", "OLD REPLAY")));
                    if (nativeChildren && Boolean.getBoolean("loopra.fake.replayChildren")) nativeTranscript();
                    if (Boolean.getBoolean("loopra.fake.replayLegacyChildren")) legacyCodexTranscript("legacy-codex");
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
                    if (List.of("input", "child-input", "input-timeout").contains(text)) {
                        if (!forms) { response(id, Map.of("stopReason", "refusal")); continue; }
                        String source = "child-input".equals(text) ? "child-1" : "fake-session";
                        if (!source.equals("fake-session")) spawnChild("fake-session", source, "Explorer", "Ask a question");
                        Map<String, Object> request = new LinkedHashMap<>();
                        request.put("sessionId", source); request.put("mode", "form"); request.put("message", "午餐吃什么？");
                        request.put("requestedSchema", Map.of("type", "object", "required", List.of("food"), "properties", Map.of(
                                "food", Map.of("type", "string", "title", "选择午餐", "oneOf", List.of(Map.of("const", "chicken", "title", "黄焖鸡"), Map.of("const", "kfc", "title", "肯德基"))),
                                "food_note", Map.of("type", "string", "title", "补充说明"))));
                        if (text.equals("input-timeout")) request.put("_meta", Map.of("codex", Map.of("autoResolutionMs", 150)));
                        promptId = id; answeringInput = true;
                        send(Map.of("jsonrpc", "2.0", "id", "form-request", "method", "elicitation/create", "params", request));
                        continue;
                    }
                    if (text.equals("progress")) {
                        update(Map.of("sessionUpdate", "plan", "entries", List.of(Map.of("content", "Read project", "status", "completed", "priority", "high"),
                                Map.of("content", "Implement", "status", "in_progress", "priority", "medium"))));
                        update(Map.of("sessionUpdate", "available_commands_update", "availableCommands", List.of(Map.of("name", "review", "description", "Review code", "input", Map.of("hint", "branch")), Map.of("name", "plan", "description", "Plan changes"))));
                        response(id, Map.of("stopReason", "end_turn")); continue;
                    }
                    if (text.equals("clear-progress")) {
                        update(Map.of("sessionUpdate", "plan", "entries", List.of()));
                        update(Map.of("sessionUpdate", "available_commands_update", "availableCommands", List.of()));
                        response(id, Map.of("stopReason", "end_turn")); continue;
                    }
                    if (text.startsWith("stop:")) { response(id, Map.of("stopReason", text.substring(5))); continue; }
                    if (text.startsWith("legacy-codex")) {
                        legacyCodexTranscript(text);
                        if (text.equals("legacy-codex-wait")) { promptId = id; continue; }
                        update(Map.of("sessionUpdate", "agent_message_chunk", "content", Map.of("type", "text", "text", "root finished")));
                        response(id, Map.of("stopReason", "end_turn")); continue;
                    }
                    if (text.startsWith("native-")) {
                        if (!nativeChildren) {
                            update(Map.of("sessionUpdate", "tool_call", "toolCallId", "spawn", "title", "spawnAgent", "status", "completed", "rawOutput", "legacy result"));
                        } else if ("native-agent".equals(text)) {
                            nativeTranscript();
                        } else if ("native-permission".equals(text) || "native-root-permission".equals(text)) {
                            spawnChild("fake-session", "child-1", "Explorer", "Read project");
                            childUpdate("child-1", Map.of("sessionUpdate", "tool_call", "toolCallId", "child-permission", "title", "Read", "status", "pending"));
                            permissionChild = "child-1"; promptId = id;
                            send(Map.of("jsonrpc", "2.0", "id", "child-approval", "method", "session/request_permission", "params", Map.of(
                                    "sessionId", "native-permission".equals(text) ? "child-1" : "fake-session",
                                    "toolCall", Map.of("toolCallId", "child-permission", "title", "Read project"),
                                    "options", List.of(Map.of("optionId", "allow", "name", "Allow once", "kind", "allow_once")))));
                            continue;
                        } else if ("native-wait".equals(text)) {
                            spawnChild("fake-session", "child-1", "Explorer", "Waiting");
                            promptId = id;
                            continue;
                        } else if ("native-failure".equals(text)) {
                            spawnChild("fake-session", "child-1", "Explorer", "Failing");
                            endChild("fake-session", "child-1", "failed");
                        }
                        update(Map.of("sessionUpdate", "agent_message_chunk", "content", Map.of("type", "text", "text", "root finished")));
                        response(id, Map.of("stopReason", "end_turn"));
                        continue;
                    }
                    if ("exit".equals(text)) System.exit(0);
                    if ("echo-mcp".equals(text)) {
                        update(Map.of("sessionUpdate", "agent_message_chunk", "content", Map.of("type", "text", "text", setup + ":" + mcp)));
                        response(id, Map.of("stopReason", "end_turn"));
                        continue;
                    }
                    if (text.contains("agent-switch")) {
                        // Simulates a permission-mode change initiated by the Agent itself
                        // (e.g. plan approval), i.e. not via session/set_config_option.
                        mode = "plan";
                        update(Map.of("sessionUpdate", "config_option_update", "configOptions", config()));
                        response(id, Map.of("stopReason", "end_turn"));
                        continue;
                    }
                    if ("agent".equals(text)) {
                        // Like the Claude adapter's flattened subagent transcript: nested
                        // traffic stays on the root session and names its Agent/Task call.
                        Map<String, Object> parent = Map.of("claudeCode", Map.of("parentToolUseId", "task-1"));
                        update(Map.of("sessionUpdate", "tool_call", "toolCallId", "task-1", "title", "Agent",
                                "kind", "other", "status", "in_progress",
                                "rawInput", Map.of("description", "Explore code", "subagent_type", "Explore")));
                        update(Map.of("sessionUpdate", "agent_message_chunk", "content", Map.of("type", "text", "text", "child says "),
                                "_meta", parent));
                        update(Map.of("sessionUpdate", "agent_thought_chunk", "content", Map.of("type", "text", "text", "child thinks"),
                                "_meta", parent));
                        update(Map.of("sessionUpdate", "tool_call", "toolCallId", "child-1", "title", "Read",
                                "kind", "read", "status", "in_progress", "rawInput", Map.of("path", "a.txt"), "_meta", parent));
                        update(Map.of("sessionUpdate", "tool_call_update", "toolCallId", "child-1",
                                "status", "completed", "rawOutput", "file contents", "_meta", parent));
                        update(Map.of("sessionUpdate", "agent_message_chunk", "content", Map.of("type", "text", "text", "done."),
                                "_meta", parent));
                        update(Map.of("sessionUpdate", "tool_call_update", "toolCallId", "task-1",
                                "status", "completed", "rawOutput", "child result"));
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
        childUpdate("fake-session", update);
    }
    private static void legacyCodexTranscript(String text) {
        var running = Map.of("senderThreadId", "fake-session", "receiverThreadIds", List.of("legacy-child"),
                "prompt", "Review the code", "agentsStates", Map.of("legacy-child", Map.of("status", "pendingInit")), "status", "completed");
        update(Map.of("sessionUpdate", "tool_call", "toolCallId", "spawn-legacy", "title", "spawnAgent", "status", "in_progress"));
        update(Map.of("sessionUpdate", "tool_call_update", "toolCallId", "spawn-legacy", "rawInput", running, "status", "completed"));
        update(Map.of("sessionUpdate", "tool_call_update", "toolCallId", "spawn-legacy", "rawInput", running, "status", "completed"));
        if (text.equals("legacy-codex-wait")) return;
        String state = text.equals("legacy-codex-failure") ? "errored" : "completed";
        var done = Map.of("senderThreadId", "fake-session", "receiverThreadIds", List.of("legacy-child"),
                "agentsStates", Map.of("legacy-child", Map.of("status", state, "message", "child review")), "status", "completed");
        update(Map.of("sessionUpdate", "tool_call", "toolCallId", "wait-legacy", "title", "wait", "rawInput", done, "status", "completed"));
        update(Map.of("sessionUpdate", "tool_call", "toolCallId", "close-legacy", "title", "closeAgent", "rawInput", done, "status", "completed"));
    }
    private static void childUpdate(String session, Map<String, Object> update) {
        send(Map.of("jsonrpc", "2.0", "method", "session/update", "params", Map.of("sessionId", session, "update", update)));
    }
    private static void spawnChild(String parent, String child, String name, String task) {
        childUpdate(parent, Map.of("sessionUpdate", "subagent_spawned", "subagentSessionId", child, "name", name, "task", task, "capabilities", Map.of()));
    }
    private static void endChild(String parent, String child, String state) {
        childUpdate(parent, Map.of("sessionUpdate", "subagent_state_update", "subagentSessionId", child, "state", state));
    }
    private static void nativeTranscript() {
        String child = System.getProperty("loopra.fake.childId", "child-1");
        childUpdate("unrelated", Map.of("sessionUpdate", "agent_message_chunk", "content", Map.of("type", "text", "text", "MUST NOT LEAK")));
        spawnChild("fake-session", child, "Explorer", "Read project");
        spawnChild("fake-session", child, "Explorer", "duplicate announcement");
        childUpdate(child, Map.of("sessionUpdate", "agent_message_chunk", "content", Map.of("type", "text", "text", "child answer")));
        childUpdate(child, Map.of("sessionUpdate", "agent_thought_chunk", "content", Map.of("type", "text", "text", "child reasoning")));
        childUpdate(child, Map.of("sessionUpdate", "tool_call", "toolCallId", "child-read", "title", "Read", "status", "in_progress", "rawInput", Map.of("path", "a.txt")));
        spawnChild(child, "grandchild", "Reviewer", "Review file");
        // Item IDs are scoped to their ACP session, so children may reuse one.
        childUpdate("grandchild", Map.of("sessionUpdate", "tool_call", "toolCallId", "child-read", "title", "Search", "status", "in_progress"));
        childUpdate("grandchild", Map.of("sessionUpdate", "tool_call_update", "toolCallId", "child-read", "status", "completed", "rawOutput", "search results"));
        childUpdate("grandchild", Map.of("sessionUpdate", "agent_message_chunk", "content", Map.of("type", "text", "text", "nested answer")));
        childUpdate("grandchild", Map.of("sessionUpdate", "usage_update", "used", 999999, "size", 1000000));
        endChild(child, "grandchild", "completed");
        childUpdate(child, Map.of("sessionUpdate", "tool_call_update", "toolCallId", "child-read", "status", "completed", "rawOutput", "file contents"));
        endChild("fake-session", child, "completed");
    }
    private static void response(Object id, Object result) { send(Map.of("jsonrpc", "2.0", "id", id, "result", result)); }
    private static void send(Object value) { System.out.println(ONode.serialize(value)); System.out.flush(); }
}
