package site.sorghum.loopra.bin.agent.core;

import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;
import org.noear.solon.ai.chat.tool.FunctionToolDesc;
import site.sorghum.cutin.core.model.ModelCallRequest;
import site.sorghum.loopra.bin.agent.context.ConversationContext;
import site.sorghum.loopra.bin.agent.environment.SessionEnvironment;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.bin.agent.prompt.PromptPrefix;
import site.sorghum.loopra.bin.model.TestLoopraProvider;
import site.sorghum.loopra.bin.tool.ToolRegistry;
import site.sorghum.loopra.tool.AgentOutput;

import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

class HitlContinuationTest {
    @Test
    void consecutiveApprovalsExecuteTheLatestBatchAndCarryAllResultsForward() throws Exception {
        List<ModelCallRequest> requests = new ArrayList<>();
        List<String> executed = new ArrayList<>();
        TestLoopraProvider provider = TestLoopraProvider.builder().stream(request -> {
            requests.add(request);
            int step = requests.size();
            return step <= 3
                    ? TestLoopraProvider.toolCallsStream(toolCalls(step))
                    : TestLoopraProvider.contentStream("done");
        }).build();
        ToolRegistry registry = new ToolRegistry() {
            @Override
            public void refresh() { }
        };
        registry.setDisabledTools(Set.of());
        registry.setEnvironment(SessionEnvironment.local(Paths.get(".").toAbsolutePath()));
        registry.register(new FunctionToolDesc("write")
                .description("write")
                .inputSchema("{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"}}}")
                .returnType(String.class)
                .doHandle(args -> {
                    String path = String.valueOf(args.get("path"));
                    executed.add(path);
                    return "contents:" + path;
                }));
        AgentLoop loop = new AgentLoop(provider, registry,
                new ConversationContext(new PromptPrefix("test", new ONode().asArray())), null);
        loop.setOutput(AgentOutput.NOOP);
        loop.setHitlMode("approval");

        loop.run(UserMessage.of("inspect the directory"));
        for (int step = 1; step <= 3; step++) {
            assertTrue(loop.hasPendingHITL());
            assertEquals("{\"path\":\"file-" + step + "\"}",
                    loop.getHitlManager().getPendingHITTcList().get(0).arguments());
            loop.approveHITL();
            String result = loop.run(null);
            assertEquals("file-" + step, executed.get(step - 1),
                    "Each approval must execute the batch currently shown to the user");
            if (step == 3) assertEquals("done", result);
        }
        assertFalse(loop.hasPendingHITL());
        assertEquals(List.of("file-1", "file-2", "file-3"), executed);
        for (int step = 1; step < requests.size(); step++) {
            var messages = requests.get(step).messages();
            assertTrue(messages.stream().anyMatch(message -> "user".equals(message.role())
                    && "inspect the directory".equals(message.content())));
            for (int batch = 1; batch <= step; batch++) {
                String id = "call-" + batch;
                String content = "contents:file-" + batch;
                assertTrue(messages.stream().anyMatch(message -> message.toolCalls().stream()
                        .anyMatch(call -> id.equals(call.id()))), "Missing assistant call " + id);
                assertTrue(messages.stream().anyMatch(message -> "tool".equals(message.role())
                        && id.equals(message.toolCallId()) && content.equals(message.content())),
                        "Missing result " + id);
            }
        }
    }

    private static ONode toolCalls(int step) {
        ONode calls = new ONode().asArray();
        ONode call = calls.addNew();
        call.set("id", "call-" + step);
        call.set("index", 0);
        call.getOrNew("function").set("name", "write");
        call.getOrNew("function").set("arguments", "{\"path\":\"file-" + step + "\"}");
        return calls;
    }
}
