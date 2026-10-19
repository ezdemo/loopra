package site.sorghum.loopra.bin.acp;

import com.agentclientprotocol.sdk.spec.AcpSchema.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

@Timeout(30)
class AcpMcpToolSetTest {
    @TempDir Path root;

    static McpServerStdio server(String value) {
        return new McpServerStdio("probe", Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                List.of("-cp", System.getProperty("surefire.test.class.path", System.getProperty("java.class.path")), FakeMcpProcess.class.getName()),
                List.of(new EnvVariable("MCP_TEST_VALUE", value)));
    }

    @Test void callsRealStdioWithSessionCwdEnvironmentErrorsAndCleanup() throws Throwable {
        long pid;
        try (var tools = new AcpMcpToolSet(List.of(server("test-value")), root)) {
            var tool = tools.tools().stream().filter(t -> t.name().equals("mcp_probe")).findFirst().orElseThrow();
            String text = tool.call(Map.of()).toString();
            assertTrue(text.contains(root.toString()), text);
            assertTrue(text.contains("env=test-value"), text);
            assertTrue(tool.call(Map.of("fail", true)).isError());
            String raw = tool.call(Map.of()).getContent();
            pid = Long.parseLong(raw.substring(raw.indexOf(";pid=") + 5));
        }
        ProcessHandle.of(pid).ifPresent(process -> {
            try { process.onExit().get(5, java.util.concurrent.TimeUnit.SECONDS); }
            catch (Exception error) { fail("MCP child process was not released", error); }
        });
    }

    @Test void duplicateServersAreRejectedBeforeAnyProcessStarts() {
        assertThrows(IllegalArgumentException.class, () -> new AcpMcpToolSet(List.of(server("one"), server("two")), root));
    }

    @Test void httpMcpPreservesAuthorizationAndToolResults() throws Throwable {
        var server = com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        var authorization = new java.util.concurrent.atomic.AtomicReference<String>();
        server.createContext("/mcp", exchange -> {
            try {
                if (!"POST".equals(exchange.getRequestMethod())) { exchange.sendResponseHeaders(405, -1); return; }
                authorization.set(exchange.getRequestHeaders().getFirst("Authorization"));
                var message = org.noear.snack4.ONode.ofJson(new String(exchange.getRequestBody().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8));
                Object id = message.get("id").getValue();
                if (id == null) { exchange.sendResponseHeaders(202, -1); return; }
                Object result = switch (message.get("method").getString()) {
                    case "initialize" -> Map.of("protocolVersion", message.get("params").get("protocolVersion").getString(),
                            "capabilities", Map.of("tools", Map.of()), "serverInfo", Map.of("name", "http-test", "version", "1"));
                    case "tools/list" -> Map.of("tools", List.of(Map.of("name", "http_probe", "description", "test HTTP MCP",
                            "inputSchema", Map.of("type", "object", "properties", Map.of()))));
                    case "tools/call" -> Map.of("content", List.of(Map.of("type", "text", "text", "http result")), "isError", false);
                    default -> Map.of();
                };
                byte[] body = org.noear.snack4.ONode.serialize(Map.of("jsonrpc", "2.0", "id", id, "result", result)).getBytes(java.nio.charset.StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, body.length);
                exchange.getResponseBody().write(body);
            } finally { exchange.close(); }
        });
        server.start();
        try (var tools = new AcpMcpToolSet(List.of(new McpServerHttp("http", "http://127.0.0.1:" + server.getAddress().getPort() + "/mcp",
                List.of(new HttpHeader("Authorization", "Bearer test-token")))), root)) {
            assertEquals("http result", tools.tools().iterator().next().call(Map.of()).getContent());
            assertEquals("Bearer test-token", authorization.get());
        } finally { server.stop(0); }
    }
}
