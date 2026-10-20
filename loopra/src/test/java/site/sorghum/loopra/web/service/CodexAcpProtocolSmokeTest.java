package site.sorghum.loopra.web.service;

import com.agentclientprotocol.sdk.client.AcpClient;
import com.agentclientprotocol.sdk.spec.AcpSchema.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/** Real adapter and bundled app-server handshake. No account, authentication or inference. */
@EnabledIfSystemProperty(named = "loopra.test.codex.protocol", matches = "true")
@Timeout(40)
class CodexAcpProtocolSmokeTest {
    @TempDir Path home;

    @Test void installedAdapterNegotiatesTheWorkbenchProtocolWithTheJavaSdk() throws Exception {
        var install = CodexAcpProcess.detect();
        assertTrue(install.available(), install.reason());
        var env = new HashMap<>(AcpRuntimePaths.withNodePath(install.node(), System.getenv(),
                System.getProperty("os.name").startsWith("Windows")));
        // Keep this protocol test independent of the developer's real account and project config.
        env.keySet().removeIf(key -> List.of("CODEX_PATH", "CODEX_CONFIG", "MODEL_PROVIDER", "DEFAULT_AUTH_REQUEST",
                "CODEX_API_KEY", "OPENAI_API_KEY", "INITIAL_AGENT_MODE").stream().anyMatch(key::equalsIgnoreCase));
        env.put("CODEX_HOME", Files.createDirectories(home.resolve("codex")).toString());
        env.put("NO_BROWSER", "1");
        var transport = new AcpProcessTransport(List.of(install.node().toString(), install.adapter().toString()), env, home);
        try (var client = AcpClient.sync(transport).requestTimeout(Duration.ofSeconds(25)).build()) {
            var initialized = client.initialize(new InitializeRequest(1,
                    new ClientCapabilities(new FileSystemCapability(false, false), false, null,
                            Map.of("loopra.dev/workbench", true)),
                    new Implementation("loopra-protocol-test", "1", "Loopra Protocol Test"), null));
            assertEquals(1, initialized.protocolVersion());
            assertNotNull(initialized.agentCapabilities());
            assertEquals(true, initialized.agentCapabilities().loadSession());
            assertNotNull(initialized.agentCapabilities().mcpCapabilities());
            assertEquals(true, initialized.agentCapabilities().mcpCapabilities().http());
        } finally { transport.close(); }
    }
}
