package site.sorghum.loopra.tool.solon;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.noear.solon.ai.chat.tool.FunctionTool;
import org.noear.solon.ai.chat.tool.FunctionToolDesc;
import org.noear.solon.core.AppContext;
import site.sorghum.loopra.bin.agent.environment.ChatMode;
import site.sorghum.loopra.tool.SolonToTools;
import site.sorghum.loopra.tool.solon.common.LoopraSkillProvider;
import site.sorghum.loopra.tool.solon.mcp.LoopraMcpSkill;
import site.sorghum.loopra.tool.solon.mcp.McpFunctionTool;
import site.sorghum.loopra.tool.solon.webfetch.LoopraWebSkill;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collection;
import java.util.Set;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.*;

class SolonToolScanProviderTest {
    @TempDir Path home;

    @Test
    void pureChatScansOnlyBuiltInNetworkToolsWithoutLoadingSkillsOrGateways() {
        String previousHome = System.getProperty("user.home");
        System.setProperty("user.home", home.toString());
        AppContext context = new AppContext();
        try {
            context.wrapAndPut("gateway", new FunctionToolDesc("project_gateway_tool"));
            context.wrapAndPut("shell", new FunctionToolDesc("bash"));
            context.wrapAndPut("file", new FunctionToolDesc("read"));
            context.wrapAndPut("external", new McpFunctionTool(new FunctionToolDesc("webfetch")));
            context.wrapAndPut("web", new LoopraWebSkill());
            context.wrapAndPut("mcp", new LoopraMcpSkill() {
                @Override public Collection<FunctionTool> getSolonTools() {
                    throw new AssertionError("Pure chat must not enumerate MCP tools");
                }
                @Override public String getSystemPrompt() {
                    throw new AssertionError("Pure chat must not load MCP instructions");
                }
            });
            context.wrapAndPut("gateway", new SolonToTools() {
                @Override public Collection<FunctionTool> getSolonTools() {
                    throw new AssertionError("Pure chat must not enumerate other gateways");
                }
            });
            SolonToolScanProvider scanner = new SolonToolScanProvider();
            Path chatRoot = ChatMode.root();
            var tools = scanner.scanTools(chatRoot, context);
            Set<String> names = tools.stream()
                    .map(FunctionTool::name).collect(Collectors.toSet());

            assertEquals(Set.of("webfetch", "websearch", "codesearch"), names);
            assertEquals(3, tools.size());
            assertTrue(tools.stream().noneMatch(tool -> tool instanceof McpFunctionTool));
            assertEquals("", scanner.getSkillToolDescription(chatRoot));
            assertFalse(LoopraSkillProvider.cliSkillProviderMap.containsKey(chatRoot.toString()));
            assertFalse(Files.exists(chatRoot));
        } finally {
            context.clear();
            System.setProperty("user.home", previousHome);
        }
    }
}
