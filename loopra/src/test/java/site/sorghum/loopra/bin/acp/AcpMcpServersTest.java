package site.sorghum.loopra.bin.acp;

import com.agentclientprotocol.sdk.spec.AcpSchema.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.loopra.bin.agent.environment.ChatMode;
import java.nio.file.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class AcpMcpServersTest {
    @TempDir Path root;

    @Test void mergesBothFormatsAndProjectDisableMasksGlobal() throws Exception {
        Path global = root.resolve("global.json");
        Files.writeString(global, """
                {"servers":[
                  {"name":"shared","type":"stdio","command":"old"},
                  {"name":"masked","type":"stdio","command":"old"},
                  {"name":"global","type":"streamable","url":"https://example.test/mcp","headers":{"Authorization":"Bearer secret"}},
                  {"name":"disabled","type":"stdio","command":"old","enabled":false}
                ]}
                """);
        Path project = root.resolve("project");
        Files.createDirectories(project.resolve(".loopra"));
        Files.writeString(project.resolve(".loopra/mcp-servers.json"), """
                {"mcpServers":{
                  "shared":{"command":"node","args":["with spaces.js"],"env":{"TOKEN":"project-secret"}},
                  "masked":{"command":"ignored","enabled":false},
                  "events":{"type":"sse","url":"https://example.test/sse"}
                }}
                """);
        var servers = AcpMcpServers.managed(global, project);
        assertEquals(Set.of("shared", "global", "events"), servers.stream().map(AcpMcpServers::name).collect(java.util.stream.Collectors.toSet()));
        var shared = (McpServerStdio) servers.stream().filter(s -> AcpMcpServers.name(s).equals("shared")).findFirst().orElseThrow();
        assertEquals("node", shared.command());
        assertEquals(List.of("with spaces.js"), shared.args());
        assertEquals(List.of(new EnvVariable("TOKEN", "project-secret")), shared.env());
        for (McpServer server : servers) assertEquals(server, AcpMcpServers.toAcp(AcpMcpServers.name(server), AcpMcpServers.fromAcp(server)));
        assertTrue(AcpMcpServers.managed(root.resolve("missing"), root.resolve("other")).isEmpty());
    }

    @Test void malformedConfigFailsWithoutLeakingValues() throws Exception {
        Path global = root.resolve("broken.json");
        Files.writeString(global, "{\"secret\":\"sensitive-value\",");
        var error = assertThrows(IllegalStateException.class, () -> AcpMcpServers.managed(global, root));
        assertFalse(error.toString().contains("sensitive-value"));
        assertNull(error.getCause());
    }

    @Test void pureChatSkipsGlobalAndProjectConfigurationBeforeParsing() throws Exception {
        String previousHome = System.getProperty("user.home");
        System.setProperty("user.home", root.toString());
        try {
            Path global = root.resolve(".loopra/mcp-servers.json");
            Files.createDirectories(global.getParent());
            Files.writeString(global, "{broken global configuration");
            assertFalse(Files.exists(ChatMode.root()));
            assertTrue(AcpMcpServers.managed(ChatMode.root()).isEmpty());

            Path project = ChatMode.root().resolve(".loopra/mcp-servers.json");
            Files.createDirectories(project.getParent());
            Files.writeString(project, "{broken project configuration");
            assertTrue(AcpMcpServers.managed(global, ChatMode.root()).isEmpty());
        } finally {
            System.setProperty("user.home", previousHome);
        }
    }
}
