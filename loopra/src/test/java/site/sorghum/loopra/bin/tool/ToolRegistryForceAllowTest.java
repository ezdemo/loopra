package site.sorghum.loopra.bin.tool;

import org.junit.jupiter.api.Test;
import org.noear.solon.ai.chat.tool.FunctionToolDesc;
import site.sorghum.loopra.integration.cutin.CutinFunctionToolBridge;

import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

class ToolRegistryForceAllowTest {

    @Test
    void forceAllowToolsRemovesPreviouslyRegisteredToolsAndFiltersNewTools() {
        ToolRegistry registry = new ToolRegistry().setDisabledTools(Set.of());
        registry.register(tool("read"));
        registry.register(tool("edit"));

        registry.setForceAllowTools(Set.of("read"));
        registry.register(tool("bash"));

        assertTrue(registry.has("read"));
        assertFalse(registry.has("edit"));
        assertFalse(registry.has("bash"));
        assertFalse(registry.isEnabled("edit"));
    }

    @Test
    void duplicateNameCannotReplaceFirstRegisteredTool() {
        ToolRegistry registry = new ToolRegistry().setDisabledTools(Set.of());
        FunctionToolDesc trustedRead = tool("read");
        FunctionToolDesc duplicateWrite = tool("read");
        ToolMetadata.applyReadOnlyOverride(trustedRead, true);
        ToolMetadata.applyReadOnlyOverride(duplicateWrite, false);

        registry.register(trustedRead);
        registry.register(duplicateWrite);

        assertSame(trustedRead, registry.get("read"));
        assertTrue(ToolMetadata.isReadOnly(registry.get("read")));
    }

    @Test
    void forceAllowPolicyAlsoFiltersToolsRegisteredByExternalPlugins() {
        ToolRegistry registry = new ToolRegistry().setDisabledTools(Set.of());
        registry.setForceAllowTools(Set.of("webfetch"));

        registry.cutinRegistry().register(new CutinFunctionToolBridge(tool("read")));
        registry.cutinRegistry().register(new CutinFunctionToolBridge(tool("webfetch")));

        assertTrue(registry.cutinRegistry().find("read").isEmpty());
        assertTrue(registry.cutinRegistry().find("webfetch").isPresent());
    }

    @Test
    void relaxingForcePolicyRestoresLegacyToolsIncludingHiddenRegistrations() {
        ToolRegistry registry = new ToolRegistry().setDisabledTools(Set.of());
        FunctionToolDesc read = tool("read");
        FunctionToolDesc edit = tool("edit");
        registry.register(read);
        registry.setForceAllowTools(Set.of("webfetch"));
        registry.register(edit);
        assertFalse(registry.has("read"));
        assertFalse(registry.has("edit"));

        registry.setForceAllowTools(null);
        assertSame(read, registry.get("read"));
        assertSame(edit, registry.get("edit"));
        registry.setForceDenyTools(Set.of("read"));
        assertFalse(registry.has("read"));
        registry.setForceDenyTools(Set.of());
        assertSame(read, registry.get("read"));
    }

    @Test
    void disabledPolicyImmediatelyUpdatesLegacySchemasAndRestoresInstances() {
        ToolRegistry registry = new ToolRegistry().setDisabledTools(Set.of());
        FunctionToolDesc read = tool("read");
        registry.register(read);
        assertEquals(1, registry.toOpenAiTools().getArray().size());
        registry.setDisabledTools(Set.of("read"));
        assertFalse(registry.has("read"));
        assertTrue(registry.cutinRegistry().find("read").isEmpty());
        assertEquals(0, registry.toOpenAiTools().getArray().size());
        registry.setDisabledTools(Set.of());
        assertSame(read, registry.get("read"));
        assertEquals(1, registry.toOpenAiTools().getArray().size());
    }

    private static FunctionToolDesc tool(String name) {
        return new FunctionToolDesc(name)
                .description(name)
                .inputSchema("{\"type\":\"object\"}")
                .returnType(String.class)
                .doHandle(args -> "ok");
    }
}
