package site.sorghum.loopra.web.controller;

import org.junit.jupiter.api.*;
import org.junit.jupiter.api.io.TempDir;
import org.noear.snack4.ONode;
import site.sorghum.loopra.bin.mcp.AgentMcpPreferences;
import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.service.AgentService;

import java.nio.file.*;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class AgentMcpControllerTest {
    @TempDir Path home;
    private String previousHome;
    private AgentEngineController controller;

    @BeforeEach void setUp() throws Exception {
        previousHome = System.getProperty("user.home");
        System.setProperty("user.home", home.toString());
        controller = new AgentEngineController();
        var field = AgentEngineController.class.getDeclaredField("agents");
        field.setAccessible(true);
        field.set(controller, new AgentService() {
            @Override public String resolveProjectHashOrThrow(String hash) {
                if (!"project".equals(hash)) throw new ServiceException("项目不存在");
                return home.resolve("project").toString();
            }
        });
        Files.createDirectories(home.resolve(".loopra"));
        Files.writeString(home.resolve(".loopra/mcp-servers.json"), """
                {"mcpServers":{"docs":{"command":"node","env":{"TOKEN":"secret-token"}},
                "shared":{"command":"global"}}}
                """);
        Files.createDirectories(home.resolve("project/.loopra"));
        Files.writeString(home.resolve("project/.loopra/mcp-servers.json"), """
                {"mcpServers":{"shared":{"command":"project","enabled":false}}}
                """);
    }

    @AfterEach void restoreHome() { System.setProperty("user.home", previousHome); }

    @Test void listsEffectiveSourcesWithoutConnectionSecretsAndSavesOnlyCurrentAgent() throws Exception {
        var list = controller.mcp("codex", "project").getData();
        assertEquals(2, list.size());
        assertTrue(list.get(0).enabled());
        assertEquals("global", list.get(0).source());
        assertEquals("project", list.get(1).source());
        assertFalse(list.get(1).configuredEnabled());
        assertFalse(ONode.serialize(list).contains("secret-token"));
        String original = Files.readString(home.resolve(".loopra/mcp-servers.json"));
        var changed = controller.configureMcp(new AgentEngineController.McpChange("codex", "project", "docs", false)).getData();
        assertFalse(changed.get(0).enabled());
        assertEquals(Map.of("docs", false), AgentMcpPreferences.choices("codex"));
        assertTrue(controller.mcp("native", "project").getData().get(0).enabled());
        assertEquals(original, Files.readString(home.resolve(".loopra/mcp-servers.json")));
    }

    @Test void enablesDisabledConfigurationForCurrentAgentWithoutChangingDefaults() throws Exception {
        Path projectConfig = home.resolve("project/.loopra/mcp-servers.json");
        String original = Files.readString(projectConfig);
        var changed = controller.configureMcp(new AgentEngineController.McpChange("codex", "project", "shared", true)).getData();
        assertTrue(changed.get(1).enabled());
        assertFalse(changed.get(1).configuredEnabled());
        assertTrue(controller.mcp("codex", "project").getData().get(1).enabled());
        assertFalse(controller.mcp("native", "project").getData().get(1).enabled());
        var forwarded = site.sorghum.loopra.bin.acp.AcpMcpServers.managed(home.resolve("project"), "codex");
        assertTrue(forwarded.stream().anyMatch(server -> "shared".equals(site.sorghum.loopra.bin.acp.AcpMcpServers.name(server))));
        assertEquals(original, Files.readString(projectConfig));
    }

    @Test void rejectsUnknownAgentsAndServers() {
        assertThrows(ServiceException.class, () -> controller.mcp("unknown", "project"));
        assertThrows(ServiceException.class, () -> controller.mcp("native", "missing"));
        assertThrows(ServiceException.class, () -> controller.configureMcp(new AgentEngineController.McpChange("codex", "project", "missing", false)));
        assertFalse(Files.exists(AgentMcpPreferences.path()));
    }
}
