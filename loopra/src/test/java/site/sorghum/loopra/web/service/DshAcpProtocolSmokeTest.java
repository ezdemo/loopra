package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.io.TempDir;
import com.agentclientprotocol.sdk.client.AcpClient;
import com.agentclientprotocol.sdk.spec.AcpSchema.*;
import site.sorghum.loopra.tool.AgentOutput;

import java.nio.file.Path;
import java.time.Duration;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/** Real installed DSH and its plugins. Uses existing DSH configuration, without a model prompt. */
@EnabledIfSystemProperty(named = "loopra.test.dsh.protocol", matches = "true")
@Timeout(60)
class DshAcpProtocolSmokeTest {
    @TempDir Path workspace;

    @Test void officialAdapterDoesNotAdvertiseForkOrPresetConfiguration() {
        try (var client = AcpClient.sync(DshAcpProcess.create(workspace)).requestTimeout(Duration.ofSeconds(25)).build()) {
            var response = client.initialize(new InitializeRequest(1,
                    new ClientCapabilities(new FileSystemCapability(false, false), false, null, null),
                    new Implementation("loopra-dsh-protocol-test", "1", "Loopra DSH Protocol Test"), null));
            assertEquals("deepseek-harness-acp", response.agentInfo().name());
            var sessions = response.agentCapabilities().sessionCapabilities();
            assertNotNull(sessions.resume());
            assertNull(sessions.fork(), "Review the upstream contract if historical forking becomes available");
        }
    }

    @Test void installedDshCreatesAndResumesAConfiguredSessionDespitePluginConsoleLogs() {
        var install = DshAcpProcess.detect();
        assertTrue(install.available(), install.reason());
        String id;
        try (var client = new AcpWorkbenchClient(DshAcpProcess.create(workspace), AgentOutput.NOOP)) {
            id = client.open(workspace.toString());
            assertNotNull(id);
            assertTrue(client.configOptions().stream().anyMatch(option -> option.category().equals("model")));
            assertTrue(client.configOptions().stream().allMatch(option ->
                    "model".equals(option.category()) || "thought_level".equals(option.category())),
                    "Review newly advertised options if the official ACP bridge adds presets or permission modes");
        }
        try (var client = new AcpWorkbenchClient(DshAcpProcess.create(workspace), AgentOutput.NOOP)) {
            assertEquals(id, client.open(workspace.toString(), id, List.of()));
            assertTrue(client.configOptions().stream().anyMatch(option -> option.category().equals("model")));
        }
    }
}
