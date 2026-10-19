package site.sorghum.loopra.bin.acp;

import com.agentclientprotocol.sdk.agent.support.AcpAgentSupport;
import com.agentclientprotocol.sdk.spec.AcpSchema.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.bin.model.TestLoopraProvider;
import site.sorghum.loopra.tool.AgentOutput;
import site.sorghum.loopra.web.service.AcpWorkbenchClient;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.CopyOnWriteArrayList;
import static org.junit.jupiter.api.Assertions.*;

@Timeout(40)
class NativeAcpMcpTest {
    @TempDir Path root;

    @Test void nativeReceivesToolsOverAcpAndReloadRemovesThemFromFrozenView() throws Exception {
        List<List<String>> requests = new CopyOnWriteArrayList<>();
        var manager = new AcpSessionManager(settings -> TestLoopraProvider.builder().model(settings.model())
                .stream(request -> {
                    requests.add(request.tools().stream().map(t -> t.id()).toList());
                    return TestLoopraProvider.contentStream("done");
                }).build());
        try {
            String id;
            try (var connection = new Connection(manager)) {
                id = connection.client.open(root.toString(), null, List.of(), List.of(AcpMcpToolSetTest.server("first")));
                connection.client.prompt(UserMessage.of("tools available"), Map.of());
                assertTrue(requests.get(0).contains("mcp_probe"), requests.toString());
            }
            try (var connection = new Connection(manager)) {
                assertEquals(id, connection.client.open(root.toString(), id, List.of(), List.of()));
                connection.client.prompt(UserMessage.of("tools revoked"), Map.of());
                assertFalse(requests.get(requests.size() - 1).contains("mcp_probe"), requests.toString());
            }
            // The other conversation cannot inherit the first conversation's MCP clients.
            try (var connection = new Connection(manager)) {
                connection.client.open(root.toString(), null, List.of(), List.of());
                connection.client.prompt(UserMessage.of("isolated"), Map.of());
                assertFalse(requests.get(requests.size() - 1).contains("mcp_probe"));
            }
        } finally { manager.dispose(); }
    }

    @Test void unsupportedHttpFailsBeforeSessionCreation() throws Exception {
        var manager = new AcpSessionManager(settings -> TestLoopraProvider.returningStream("done")) {
            @Override public boolean supportsMcpServers() { return false; }
        };
        try (var connection = new Connection(manager)) {
            var error = assertThrows(IllegalStateException.class, () -> connection.client.open(root.toString(), null, List.of(),
                    List.of(new McpServerHttp("remote", "https://example.test/mcp", List.of()))));
            assertTrue(error.getMessage().contains("HTTP MCP"));
            assertTrue(manager.listSessions().isEmpty());
        } finally { manager.dispose(); }
    }

    private static final class Connection implements AutoCloseable {
        final JsonRpcLoopback wire = new JsonRpcLoopback();
        final AcpAgentSupport server;
        final AcpWorkbenchClient client;
        Connection(AcpSessionBackend backend) {
            var agent = new LoopraAcpAgent(backend);
            server = AcpAgentSupport.create(agent).transport(wire.agent()).build();
            agent.setUpdateSender(server.getAgent()::sendSessionUpdate);
            server.start();
            client = new AcpWorkbenchClient(wire.client(), AgentOutput.NOOP);
        }
        public void close() { client.close(); server.close(); wire.close(); }
    }
}
