package site.sorghum.loopra.bin.agent.core;

import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;
import org.noear.solon.ai.chat.tool.FunctionToolDesc;
import site.sorghum.loopra.bin.agent.context.ContextTokenEstimate;
import site.sorghum.loopra.bin.agent.context.ConversationContext;
import site.sorghum.loopra.bin.agent.prompt.PromptPrefix;
import site.sorghum.loopra.bin.model.TestLoopraProvider;
import site.sorghum.loopra.bin.tool.ToolRegistry;

import java.io.IOException;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;

class AgentLoopPromptFreezeTest {

    @Test
    void frozenPrefixIgnoresLaterInstructionAndToolChanges() {
        ToolRegistry registry = new ToolRegistry().setDisabledTools(Set.of());
        registry.register(tool("read"));
        ConversationContext context = new ConversationContext(
                new PromptPrefix("system", registry.toOpenAiTools()));
        AgentLoop loop = new AgentLoop(
                TestLoopraProvider.builder().model("test-model").build(),
                registry, context, null);

        loop.freezePromptPrefix();
        ContextTokenEstimate before = loop.estimateCurrentContext();

        registry.register(tool("edit"));
        ContextTokenEstimate after = loop.estimateCurrentContext();

        assertEquals(before.systemTokens(), after.systemTokens());
        assertEquals(before.toolDefinitionTokens(), after.toolDefinitionTokens());
        assertEquals(1, loop.refreshTools().size());
    }

    private static FunctionToolDesc tool(String name) {
        return new FunctionToolDesc(name)
                .description(name)
                .inputSchema("{\"type\":\"object\"}")
                .returnType(String.class)
                .doHandle(args -> "ok");
    }

}
