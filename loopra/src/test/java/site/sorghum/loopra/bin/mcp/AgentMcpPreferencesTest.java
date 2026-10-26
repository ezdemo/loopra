package site.sorghum.loopra.bin.mcp;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.loopra.bin.acp.AcpMcpServers;

import java.nio.file.*;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

class AgentMcpPreferencesTest {
    @TempDir Path root;

    @Test void persistsIndependentChoicesAndPreservesOtherServers() throws Exception {
        Path file = root.resolve("agent-mcp.json");
        assertEquals(Map.of(), AgentMcpPreferences.choices(file, "codex"));
        AgentMcpPreferences.set(file, "codex", "one", false);
        AgentMcpPreferences.set(file, "codex", "two", false);
        AgentMcpPreferences.set(file, "native", "one", true);
        assertEquals(Map.of("one", false, "two", false), AgentMcpPreferences.choices(file, "codex"));
        assertEquals(Map.of("one", true), AgentMcpPreferences.choices(file, "native"));
        AgentMcpPreferences.set(file, "codex", "one", true);
        assertEquals(Map.of("one", true, "two", false), AgentMcpPreferences.choices(file, "codex"));
        assertEquals(Map.of(), AgentMcpPreferences.choices(file, "claude-code"));
    }

    @Test void nativeForwardingOverridesDefaultsOnlyForSelectedAgent() throws Exception {
        String previousHome = System.getProperty("user.home");
        System.setProperty("user.home", root.toString());
        try {
            Path config = root.resolve(".loopra/mcp-servers.json");
            Files.createDirectories(config.getParent());
            String original = """
                    {"mcpServers":{"one":{"command":"node"},"two":{"command":"node"},
                    "disabled":{"command":"node","enabled":false}}}
                    """;
            Files.writeString(config, original);
            AgentMcpPreferences.set(AgentMcpPreferences.path(), "native", "one", false);
            AgentMcpPreferences.set(AgentMcpPreferences.path(), "native", "disabled", true);
            Path workspace = root.resolve("project");
            assertEquals(List.of("two", "disabled"), AcpMcpServers.managed(workspace, "native").stream().map(AcpMcpServers::name).toList());
            assertEquals(List.of("one", "two"), AcpMcpServers.managed(workspace, "codex").stream().map(AcpMcpServers::name).toList());
            assertEquals(original, Files.readString(config));
        } finally { System.setProperty("user.home", previousHome); }
    }

    @Test void malformedPreferencesDoNotSilentlyRestoreRevokedServersOrLeakContents() throws Exception {
        Path file = root.resolve("agent-mcp.json");
        Files.writeString(file, "{secret-value");
        var error = assertThrows(IllegalStateException.class, () -> AgentMcpPreferences.choices(file, "codex"));
        assertFalse(error.toString().contains("secret-value"));
        assertNull(error.getCause());
        assertThrows(IllegalStateException.class, () -> AgentMcpPreferences.set(file, "codex", "one", true));
        assertEquals("{secret-value", Files.readString(file));
    }
}
