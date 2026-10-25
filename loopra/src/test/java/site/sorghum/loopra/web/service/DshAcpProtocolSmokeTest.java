package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.loopra.tool.AgentOutput;

import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/** Real installed DSH and its plugins. Uses existing DSH configuration, without a model prompt. */
@EnabledIfSystemProperty(named = "loopra.test.dsh.protocol", matches = "true")
@Timeout(60)
class DshAcpProtocolSmokeTest {
    @TempDir Path workspace;

    @Test void installedDshCreatesAndResumesAConfiguredSessionDespitePluginConsoleLogs() {
        var install = DshAcpProcess.detect();
        assertTrue(install.available(), install.reason());
        String id;
        try (var client = new AcpWorkbenchClient(DshAcpProcess.create(workspace), AgentOutput.NOOP)) {
            id = client.open(workspace.toString());
            assertNotNull(id);
            assertTrue(client.configOptions().stream().anyMatch(option -> option.category().equals("model")));
        }
        try (var client = new AcpWorkbenchClient(DshAcpProcess.create(workspace), AgentOutput.NOOP)) {
            assertEquals(id, client.open(workspace.toString(), id, List.of()));
            assertTrue(client.configOptions().stream().anyMatch(option -> option.category().equals("model")));
        }
    }
}
