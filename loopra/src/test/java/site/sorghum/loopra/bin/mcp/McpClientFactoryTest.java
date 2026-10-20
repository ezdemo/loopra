package site.sorghum.loopra.bin.mcp;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.noear.solon.ai.mcp.client.McpClientProvider;
import site.sorghum.loopra.bin.acp.FakeMcpProcess;
import site.sorghum.loopra.bin.config.ConfigService;
import site.sorghum.loopra.tool.solon.mcp.LoopraMcpSkill;
import site.sorghum.loopra.tool.solon.mcp.ProjectMcpSkill;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

@Timeout(30)
class McpClientFactoryTest {
    @TempDir Path root;

    private McpServerDTO server(String protocol) {
        var server = new McpServerDTO("magpie-image", "stdio", true);
        server.command = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        server.args = List.of("-cp", System.getProperty("surefire.test.class.path", System.getProperty("java.class.path")),
                FakeMcpProcess.class.getName());
        server.env = Map.of("MCP_TEST_PROTOCOL", protocol);
        return server;
    }

    @ParameterizedTest
    @ValueSource(strings = {"2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"})
    void negotiatesSupportedServerRevisionAndRetainsToolPermissions(String protocol) {
        var parameters = McpProjectConfig.toParameters(server(protocol));
        try (McpClientProvider provider = assertDoesNotThrow(() -> McpClientFactory.create("test", parameters, root))) {
            assertEquals(protocol, provider.getClient().getCurrentInitializationResult().protocolVersion());
            assertEquals("mcp_probe", provider.getTools().iterator().next().name());
            assertTrue(provider.callTool("mcp_probe", Map.of("fail", true)).isError());
            provider.setDisallowedTools(List.of("mcp_probe"));
            assertTrue(provider.getToolsActivated().isEmpty());
        }
    }

    @Test void stillRejectsUnknownRevisionsAndReleasesFailedClient() throws Exception {
        var parameters = McpProjectConfig.toParameters(server("2099-01-01"));
        try (var provider = McpClientFactory.create("test", parameters, root)) {
            RuntimeException error = assertThrows(RuntimeException.class, provider::getTools);
            StringBuilder causes = new StringBuilder();
            for (Throwable cause = error; cause != null; cause = cause.getCause()) causes.append(cause.getMessage());
            assertTrue(causes.toString().contains("Unsupported protocol version"), causes.toString());
        }
    }

    @Test void globalManagementToolListingAcceptsMagpieJune2025Handshake() throws Exception {
        var server = server("2025-06-18");
        var skill = new LoopraMcpSkill();
        var service = new McpManageService();
        inject(service, "loopraMcpSkill", skill);
        inject(service, "configService", new ConfigService());
        var field = McpManageService.class.getDeclaredField("serverStore");
        field.setAccessible(true);
        @SuppressWarnings("unchecked") var store = (Map<String, McpServerDTO>) field.get(service);
        store.put(server.name, server);
        try (var provider = McpClientFactory.create(server.name, McpProjectConfig.toParameters(server), root)) {
            skill.addMcpServer(server.name, provider);
            var tools = service.listTools(server.name);
            assertTrue(tools.connected);
            assertEquals("mcp_probe", tools.tools.get(0).name);
            assertTrue(service.checkConnection(server));
        } finally { skill.removeMcpServer(server.name); }
    }

    @Test void projectMcpUsesSameNegotiationAndCanReopenProvider() throws Exception {
        Path config = McpProjectConfig.path(root);
        Files.createDirectories(config.getParent());
        McpConfigFile.write(config, List.of(server("2025-06-18")));
        try (var skill = ProjectMcpSkill.load(root)) {
            assertNotNull(skill);
            var info = skill.serverInfos().get(0);
            assertTrue(info.loaded());
            assertNull(info.error());
            assertEquals(List.of("mcp_probe"), info.toolNames());
            var provider = skill.getMcpServer("magpie-image");
            provider.close();
            assertThrows(IllegalStateException.class, provider::getClient);
            provider.reopen();
            assertEquals("2025-06-18", provider.getClient().getCurrentInitializationResult().protocolVersion());
        }
    }

    @Test void enablingADisabledServerLoadsToolsBeforePersisting() throws Exception {
        String originalHome = System.getProperty("user.home");
        var skill = new LoopraMcpSkill();
        var service = new McpManageService();
        inject(service, "loopraMcpSkill", skill);
        var server = server("2025-06-18");
        server.enabled = false;
        var field = McpManageService.class.getDeclaredField("serverStore");
        field.setAccessible(true);
        @SuppressWarnings("unchecked") var store = (Map<String, McpServerDTO>) field.get(service);
        store.put(server.name, server);
        try {
            System.setProperty("user.home", root.toString());
            assertTrue(service.toggleServer(server.name, true).enabled);
            assertTrue(skill.getMcpServer(server.name).isEnabled());
            assertEquals(1, skill.getSolonTools().size());
            assertFalse(service.toggleServer(server.name, false).enabled);
            assertNull(skill.getMcpServer(server.name));
        } finally {
            System.setProperty("user.home", originalHome);
            skill.removeMcpServer(server.name);
        }
    }

    private static void inject(Object target, String name, Object value) throws Exception {
        var field = target.getClass().getDeclaredField(name);
        field.setAccessible(true);
        field.set(target, value);
    }
}
