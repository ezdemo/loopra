package site.sorghum.loopra.bin.mcp;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.noear.snack4.ONode;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class McpConfigFileTest {
    @TempDir Path home;

    @Test
    void mergesNativeAndStandardEntriesWithStandardPrecedenceAndDisabledFlags() throws Exception {
        Path file = config("""
                {"servers":[{"name":"native","command":"native-tool","enabled":false},
                            {"name":"shared","command":"original"}],
                 "mcpServers":{"shared":{"command":"magpie-tool","args":["--flag"],"env":{"MODE":"test"}},
                               "remote":{"type":"http","url":"https://example.test/mcp","headers":{"X-Test":"ok"},"enabled":false}}}
                """);
        var parsed = McpProjectConfig.read(file);
        assertEquals(3, parsed.size());
        assertFalse(parsed.get("native").isEnabled());
        assertEquals("magpie-tool", parsed.get("shared").getCommand());
        assertEquals(List.of("--flag"), parsed.get("shared").getArgs());
        assertEquals("test", parsed.get("shared").getEnv().get("MODE"));
        assertEquals("streamable", parsed.get("remote").getTypeOrTransport());
        assertEquals("ok", parsed.get("remote").getHeaders().get("X-Test"));
        assertFalse(parsed.get("remote").isEnabled());
    }

    @Test
    void managerRoundTripKeepsExternalEntriesSeparateAndPreservesUnknownFields() throws Exception {
        Path file = config("""
                {"theme":"dark","servers":[{"name":"mine","type":"stdio","command":"mine"}],
                 "mcpServers":{"library":{"command":"library-tool","note":"keep-me"}}}
                """);
        var servers = McpConfigFile.read(file);
        var imported = servers.stream().filter(server -> server.name.equals("library")).findFirst().orElseThrow();
        imported.args = List.of("updated");
        McpConfigFile.write(file, servers);
        ONode root = ONode.ofJson(Files.readString(file));
        assertEquals("dark", root.get("theme").getString());
        assertEquals(1, root.get("servers").getArray().size());
        assertEquals("mine", root.get("servers").get(0).get("name").getString());
        assertEquals("keep-me", root.get("mcpServers").get("library").get("note").getString());
        assertEquals("updated", McpProjectConfig.read(file).get("library").getArgs().get(0));
        // Removing the library section must not leave a stale copy in the native array.
        root.remove("mcpServers");
        Files.writeString(file, root.toJson());
        assertEquals(List.of("mine"), new ArrayList<>(McpProjectConfig.read(file).keySet()));
    }

    @Test
    void shadowedNativeConfigurationComesBackAfterLibraryRemoval() throws Exception {
        Path file = config("""
                {"servers":[{"name":"same","command":"original","env":{"KEEP":"yes"}}],
                 "mcpServers":{"same":{"command":"library"}}}
                """);
        McpConfigFile.write(file, McpConfigFile.read(file));
        ONode root = ONode.ofJson(Files.readString(file));
        root.get("mcpServers").remove("same");
        Files.writeString(file, root.toJson());
        var restored = McpProjectConfig.read(file).get("same");
        assertEquals("original", restored.getCommand());
        assertEquals("yes", restored.getEnv().get("KEEP"));
    }

    @Test
    void nativeAndStandardEntriesCanBeRemovedWithoutDroppingOtherSections() throws Exception {
        Path file = config("""
                {"custom":{"keep":true},"servers":[{"name":"mine","command":"mine"}],
                 "mcpServers":{"library":{"command":"tool"}}}
                """);
        McpConfigFile.write(file, List.of());
        assertTrue(McpProjectConfig.read(file).isEmpty());
        assertTrue(ONode.ofJson(Files.readString(file)).get("custom").get("keep").getBoolean());
    }

    @Test
    void writesNativeEntriesToNewFileAndReadsSseTransport() throws Exception {
        Path file = home.resolve("new/mcp-servers.json");
        var server = new McpServerDTO("events", "sse", true);
        server.url = "https://example.test/sse";
        McpConfigFile.write(file, List.of(server));
        assertEquals("sse", McpProjectConfig.read(file).get("events").getTypeOrTransport());
        assertEquals(1, McpConfigFile.read(file).size());
    }

    private Path config(String json) throws Exception {
        Path file = home.resolve("mcp-servers.json");
        Files.writeString(file, json);
        return file;
    }
}
