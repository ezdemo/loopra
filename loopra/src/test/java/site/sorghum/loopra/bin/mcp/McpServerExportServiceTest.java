package site.sorghum.loopra.bin.mcp;

import org.junit.jupiter.api.Test;
import org.noear.solon.ai.chat.tool.FunctionToolDesc;
import org.noear.solon.ai.mcp.server.McpServerEndpointProvider;
import org.noear.solon.ai.mcp.server.manager.StatefulMcpServerHost;

import java.util.Properties;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class McpServerExportServiceTest {

    @Test
    void createsReadableTitlesForMachineNames() {
        assertEquals("Bash Wait", McpServerExportService.readableToolTitle("bash_wait"));
        assertEquals("Web Fetch", McpServerExportService.readableToolTitle("web_fetch"));
        assertEquals("Call Api", McpServerExportService.readableToolTitle("callApi"));
    }

    @Test
    void fallsBackForMissingNames() {
        assertEquals("Loopra Tool", McpServerExportService.readableToolTitle(null));
        assertEquals("Loopra Tool", McpServerExportService.readableToolTitle("  "));
    }

    @Test
    void publishesStandardSafetyAnnotationsWithoutChangingToolHandler() {
        Properties properties = new Properties();
        properties.setProperty("name", "loopra-test");
        properties.setProperty("version", "1.0.0");
        properties.setProperty("channel", "streamable");
        properties.setProperty("mcpEndpoint", "/loopra-test-mcp");

        McpServerEndpointProvider provider = new McpServerEndpointProvider(properties);
        provider.addTool(tool("read"));
        provider.addTool(tool("edit"));

        StatefulMcpServerHost host = (StatefulMcpServerHost) provider.getServer();
        host.build();
        McpToolAnnotationSupport.apply(provider);

        var tools = host.getServer().listTools().collectList().block();
        assertNotNull(tools);
        assertEquals(2, tools.size());

        var read = tools.stream().filter(item -> "read".equals(item.name())).findFirst().orElseThrow();
        assertNotNull(read.annotations());
        assertTrue(read.annotations().readOnlyHint());
        assertFalse(read.annotations().destructiveHint());
        assertTrue(read.annotations().idempotentHint());

        var edit = tools.stream().filter(item -> "edit".equals(item.name())).findFirst().orElseThrow();
        assertNotNull(edit.annotations());
        assertFalse(edit.annotations().readOnlyHint());
        assertTrue(edit.annotations().destructiveHint());
        assertFalse(edit.annotations().idempotentHint());

        host.getServer().close();
    }

    private static FunctionToolDesc tool(String name) {
        return new FunctionToolDesc(name)
                .title(name)
                .description(name)
                .inputSchema("{\"type\":\"object\"}")
                .returnType(String.class)
                .doHandle(args -> "ok");
    }
}
