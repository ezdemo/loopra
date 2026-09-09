package site.sorghum.loopra.bin.agent.core;

import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;
import org.noear.solon.ai.chat.tool.FunctionToolDesc;
import site.sorghum.loopra.bin.agent.context.ConversationContext;
import site.sorghum.loopra.bin.agent.environment.SessionEnvironment;
import site.sorghum.loopra.bin.agent.hitl.HitlManager;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.model.HitlState;
import site.sorghum.loopra.bin.agent.model.ToolCallEntry;
import site.sorghum.loopra.bin.agent.model.ToolExecutionResult;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.bin.agent.prompt.PromptPrefix;
import site.sorghum.loopra.bin.model.TestLoopraProvider;
import site.sorghum.loopra.bin.tool.ToolMetadata;
import site.sorghum.loopra.bin.tool.ToolRegistry;
import site.sorghum.loopra.tool.AgentOutput;
import site.sorghum.loopra.tool.HitlRequiredException;
import site.sorghum.loopra.tool.ToolContext;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

class AgentLoopToolSignalTest {

    @Test
    void terminateOnNoToolCallCanBeUpdatedAtRuntime() {
        AgentLoop loop = new AgentLoop(stubProvider(), registryWith(tool("status", args -> "ok")), null, null);

        assertTrue(loop.terminateOnNoToolCall());
        loop.setTerminateOnNoToolCall(false);
        assertFalse(loop.terminateOnNoToolCall());
    }

    @Test
    void resetUserAbortAlsoClearsModelStreamAbort() {
        TestLoopraProvider client = TestLoopraProvider.builder().model("test").build();
        AgentLoop loop = new AgentLoop(client, registryWith(tool("status", args -> "ok")), null, null);

        loop.resetUserAbort();

        assertEquals(1, client.resetStreamAbortCount());
    }

    @Test
    void copiedRegistryPreservesWorkspaceForToolCwd() {
        Path workspace = Paths.get(".").toAbsolutePath().normalize();
        AtomicReference<Map<String, Object>> capturedArgs = new AtomicReference<>();
        ToolRegistry parentRegistry = registryWith(tool("workspace", args -> {
            capturedArgs.set(args);
            return "ok";
        }));
        AgentLoop childLoop = new AgentLoop(stubProvider(), parentRegistry.copy(), null, null);

        childLoop.executeToolCalls(toolCalls("workspace", "{}"));

        assertEquals(workspace.toString(), capturedArgs.get().get("__cwd"));
        ToolContext context = (ToolContext) capturedArgs.get().get("ctx");
        assertEquals(workspace, context.getRootDir().toAbsolutePath().normalize());
    }

    @Test
    void repeatedToolCallSetsSuppressionSignalAndSkipsExecution() {
        AtomicInteger executions = new AtomicInteger();
        ToolRegistry registry = registryWith(tool("edit", args -> {
            executions.incrementAndGet();
            return "ok";
        }));
        AgentLoop loop = new AgentLoop(stubProvider(), registry, null, null);
        ONode calls = toolCalls("edit", "{\"path\":\"a.java\"}");

        assertFalse(loop.executeToolCalls(calls).anySuppressed());
        assertFalse(loop.executeToolCalls(calls).anySuppressed());
        ToolExecutionResult third = loop.executeToolCalls(calls);

        assertTrue(third.anySuppressed());
        assertEquals(2, executions.get());
        assertTrue(third.toolResults().get(0).getContent().contains("\"rejectedReason\":\"storm\""));
    }

    @Test
    void hitlExceptionSetsSandboxPendingSignalAndPreservesDetails() {
        ToolRegistry registry = registryWith(tool("write", args -> {
            throw new HitlRequiredException(
                    "write", "SANDBOX_ESCAPE", "outside workspace", Map.of("path", "../secret"));
        }));
        AgentLoop loop = new AgentLoop(stubProvider(), registry, null, null);

        ToolExecutionResult result = loop.executeToolCalls(
                toolCalls("write", "{\"path\":\"../secret\"}"));

        assertFalse(result.anySuppressed());
        assertEquals(HitlState.PENDING, loop.getHitlManager().getState());
        assertTrue(loop.getHitlManager().hasSandboxPending());
        assertTrue(result.toolResults().get(0).getContent().contains("HITL_PENDING:SANDBOX_ESCAPE"));

        HitlManager.PendingSandboxState pending = loop.getHitlManager().drainSandboxHITL();
        assertEquals("outside workspace", pending.details());
    }

    @Test
    void sandboxHitlApprovalReplaysInsideCutinLoop() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        ToolRegistry registry = registryWith(tool("write", args -> {
            if (calls.incrementAndGet() == 1) {
                throw new HitlRequiredException(
                        "write", "SANDBOX_ESCAPE", "outside workspace", Map.of("path", "../secret"));
            }
            return "done";
        }));
        ConversationContext context = new ConversationContext(
                new PromptPrefix("system", new ONode().asArray()));
        AgentLoop loop = new AgentLoop(
                TestLoopraProvider.toolCallsFirstThenAnswer(
                        toolCalls("write", "{\"path\":\"../secret\"}"), "done"),
                registry, context, null);
        loop.freezePromptPrefix();
        loop.setOutput(AgentOutput.NOOP);

        String first = loop.run(UserMessage.of("please write"));

        assertTrue(first.contains("沙箱越界"));
        assertTrue(loop.getHitlManager().hasSandboxPending());

        loop.approveHITL();
        String second = loop.run(null);

        assertEquals("done", second);
        assertEquals(2, calls.get());
    }

    @Test
    void repeatedModelToolCallIdsAreNormalizedBeforeExecutionAndHistoryWrite() throws Exception {
        AtomicInteger streams = new AtomicInteger();
        ToolRegistry registry = registryWith(tool("status", args -> "ok"));
        TestLoopraProvider provider = TestLoopraProvider.builder()
            .stream(request -> {
                if (streams.getAndIncrement() < 2) {
                    return TestLoopraProvider.toolCallsStream(toolCalls("status", "{}"));
                }
                return TestLoopraProvider.contentStream("done");
            })
            .build();
        ConversationContext context = new ConversationContext(
            new PromptPrefix("system", new ONode().asArray()));
        AgentLoop loop = new AgentLoop(provider, registry, context, null);
        loop.freezePromptPrefix();
        loop.setOutput(AgentOutput.NOOP);

        assertEquals("done", loop.run(UserMessage.of("run")));

        List<String> assistantIds = context.getHistory().stream()
            .filter(ChatMessage::isAssistant)
            .filter(ChatMessage::hasToolCalls)
            .flatMap(message -> message.getToolCalls().stream())
            .map(ToolCallEntry::id)
            .toList();
        List<String> toolIds = context.getHistory().stream()
            .filter(ChatMessage::isTool)
            .map(ChatMessage::getToolCallId)
            .toList();

        assertEquals(List.of("call-1", "call-1_dedup_0"), assistantIds);
        assertEquals(List.of("call-1", "call-1_dedup_0"), toolIds);
    }

    @Test
    void planModeFiltersWriteToolsAndRejectsRememberedCalls() throws Exception {
        AtomicInteger readExecutions = new AtomicInteger();
        AtomicInteger editExecutions = new AtomicInteger();
        FunctionToolDesc read = tool("read", args -> {
            readExecutions.incrementAndGet();
            return "contents";
        });
        FunctionToolDesc edit = tool("edit", args -> {
            editExecutions.incrementAndGet();
            return "changed";
        });
        ToolMetadata.applyReadOnlyOverride(read, true);
        ToolMetadata.applyReadOnlyOverride(edit, false);
        ToolRegistry registry = registryWith(read, edit);
        AgentLoop loop = new AgentLoop(stubProvider(), registry, null, null);

        loop.setPlanMode(true);
        java.lang.reflect.Method filter = AgentLoop.class.getDeclaredMethod("filterReadOnlyTools", ONode.class);
        filter.setAccessible(true);
        ONode advertisedTools = (ONode) filter.invoke(loop, registry.toOpenAiTools());
        ToolExecutionResult rejected = loop.executeToolCalls(toolCalls("edit", "{}"));
        ToolExecutionResult allowed = loop.executeToolCalls(toolCalls("read", "{}"));

        assertEquals(1, advertisedTools.getArray().size());
        assertEquals("read", advertisedTools.get(0).get("function").get("name").getString());
        assertEquals(0, editExecutions.get());
        assertTrue(rejected.toolResults().get(0).getContent().contains("\"rejectedReason\":\"plan_mode\""));
        assertEquals(1, readExecutions.get());
        assertEquals("contents", allowed.toolResults().get(0).getContent());
    }

    @Test
    void pendingPlanIsConsumedOnlyOnce() {
        AgentLoop loop = new AgentLoop(stubProvider(), registryWith(tool("read", args -> "ok")), null, null);

        loop.submitPlan("1. inspect\n2. implement");

        assertEquals("1. inspect\n2. implement", loop.getPendingPlan());
        assertEquals("1. inspect\n2. implement", loop.consumePendingPlan());
        assertNull(loop.consumePendingPlan());
    }

    @Test
    void bashWaitIsNeverSuppressed() {
        AtomicInteger executions = new AtomicInteger();
        AgentLoop loop = new AgentLoop(stubProvider(), registryWith(tool("bash_wait", args -> {
            executions.incrementAndGet();
            return "waiting";
        })), null, null);
        ONode calls = toolCalls("bash_wait", "{\"session_id\":\"session-1\",\"yield_time_ms\":1000}");

        assertFalse(loop.executeToolCalls(calls).anySuppressed());
        assertFalse(loop.executeToolCalls(calls).anySuppressed());
        assertFalse(loop.executeToolCalls(calls).anySuppressed());
        assertEquals(3, executions.get());
    }

    @Test
    void stormExemptToolIsNeverSuppressed() {
        AtomicInteger executions = new AtomicInteger();
        FunctionToolDesc tool = tool("status", args -> {
            executions.incrementAndGet();
            return "ok";
        });
        tool.metaPut("stormExempt", true);
        AgentLoop loop = new AgentLoop(stubProvider(), registryWith(tool), null, null);
        ONode calls = toolCalls("status", "{}");

        assertFalse(loop.executeToolCalls(calls).anySuppressed());
        assertFalse(loop.executeToolCalls(calls).anySuppressed());
        assertFalse(loop.executeToolCalls(calls).anySuppressed());
        assertEquals(3, executions.get());
    }

    private static ToolRegistry registryWith(FunctionToolDesc... tools) {
        ToolRegistry registry = new ToolRegistry().setDisabledTools(Set.of());
        registry.setEnvironment(SessionEnvironment.local(Paths.get(".").toAbsolutePath()));
        for (FunctionToolDesc tool : tools) {
            registry.register(tool);
        }
        return registry;
    }

    private static TestLoopraProvider stubProvider() {
        return TestLoopraProvider.builder().build();
    }

    private static FunctionToolDesc tool(String name, org.noear.solon.ai.chat.tool.ToolHandler handler) {
        return new FunctionToolDesc(name)
                .description(name)
                .inputSchema("{\"type\":\"object\"}")
                .returnType(String.class)
                .doHandle(handler);
    }

    private static ONode toolCalls(String name, String arguments) {
        ONode calls = new ONode().asArray();
        calls.addNew().then(call -> {
            call.set("id", "call-1");
            call.set("index", "0");
            call.getOrNew("function").then(function -> {
                function.set("name", name);
                function.set("arguments", arguments);
            });
        });
        return calls;
    }

}
