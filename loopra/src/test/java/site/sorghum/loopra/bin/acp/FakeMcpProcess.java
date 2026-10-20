package site.sorghum.loopra.bin.acp;

import org.noear.snack4.ONode;
import java.util.*;

/** Real stdio MCP peer, independent of credentials and inference. */
public final class FakeMcpProcess {
    public static void main(String[] args) {
        Scanner input = new Scanner(System.in, java.nio.charset.StandardCharsets.UTF_8);
        while (input.hasNextLine()) {
            ONode message = ONode.ofJson(input.nextLine());
            Object id = message.get("id").getValue();
            String method = message.get("method").getString();
            if (id == null) continue;
            Object result = switch (method) {
                case "initialize" -> Map.of("protocolVersion", System.getenv("MCP_TEST_PROTOCOL") == null
                                ? message.get("params").get("protocolVersion").getString() : System.getenv("MCP_TEST_PROTOCOL"),
                        "capabilities", Map.of("tools", Map.of()), "serverInfo", Map.of("name", "fake", "version", "1"));
                case "tools/list" -> Map.of("tools", List.of(Map.of("name", "mcp_probe", "description", "probe cwd and environment",
                        "inputSchema", Map.of("type", "object", "properties", Map.of()))));
                case "tools/call" -> Map.of("content", List.of(Map.of("type", "text", "text",
                        "cwd=" + System.getProperty("user.dir") + ";env=" + System.getenv("MCP_TEST_VALUE") + ";pid=" + ProcessHandle.current().pid())),
                        "isError", message.get("params").get("arguments").get("fail").getBoolean());
                default -> Map.of();
            };
            System.out.println(ONode.serialize(Map.of("jsonrpc", "2.0", "id", id, "result", result)));
            System.out.flush();
        }
    }
}
