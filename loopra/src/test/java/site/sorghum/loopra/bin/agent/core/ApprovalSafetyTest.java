package site.sorghum.loopra.bin.agent.core;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.noear.snack4.ONode;
import org.noear.solon.ai.chat.tool.FunctionToolDesc;
import site.sorghum.loopra.bin.agent.context.ConversationContext;
import site.sorghum.loopra.bin.agent.environment.SessionEnvironment;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.bin.agent.prompt.PromptPrefix;
import site.sorghum.loopra.bin.model.TestLoopraProvider;
import site.sorghum.loopra.bin.tool.ToolMetadata;
import site.sorghum.loopra.bin.tool.ToolRegistry;
import site.sorghum.loopra.tool.AgentOutput;
import site.sorghum.loopra.tool.HitlRequiredException;

import java.nio.file.Paths;
import java.nio.file.Path;
import java.nio.file.Files;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

class ApprovalSafetyTest {
    @TempDir Path temporary;
    @ParameterizedTest
    @ValueSource(strings = {"read", "ls", "glob", "grep", "custom_query"})
    void readOnlyToolsExecuteWithoutValidatorOrApproval(String name) throws Exception {
        AtomicInteger executions = new AtomicInteger();
        FunctionToolDesc tool = tool(name, executions);
        if (name.equals("custom_query")) tool.metaPut("readOnly", true);
        AgentLoop loop = loop(calls(name, "{}"), tool);
        try {
            assertEquals("done", loop.run(UserMessage.of("inspect")));
            assertEquals(1, executions.get());
            assertFalse(loop.hasPendingHITL());
        } finally {
            loop.disposeCutinPlugins();
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"bash", "bash_start"})
    void shellQueriesExecuteWithoutValidatorOrApproval(String name) throws Exception {
        AtomicInteger executions = new AtomicInteger();
        AgentLoop loop = loop(calls(name, "{\"command\":\"git status --short && git diff --stat\"}"),
                tool(name, executions));
        try {
            assertEquals("done", loop.run(UserMessage.of("inspect")));
            assertEquals(1, executions.get());
            assertFalse(loop.hasPendingHITL());
        } finally {
            loop.disposeCutinPlugins();
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"write", "unknown_tool", "bash"})
    void mutationsAndUnknownToolsStillWaitForApproval(String name) throws Exception {
        AtomicInteger executions = new AtomicInteger();
        AgentLoop loop = loop(calls(name, "{\"command\":\"rm -rf src\"}"), tool(name, executions));
        try {
            assertTrue(loop.run(UserMessage.of("run")).contains("HITL"));
            assertTrue(loop.hasPendingHITL());
            assertEquals(0, executions.get());
        } finally {
            loop.disposeCutinPlugins();
        }
    }

    @Test
    void readOnlyOverrideCanRequireApprovalForBuiltInRead() throws Exception {
        AtomicInteger executions = new AtomicInteger();
        FunctionToolDesc tool = tool("read", executions);
        ToolMetadata.applyReadOnlyOverride(tool, false);
        AgentLoop loop = loop(calls("read", "{}"), tool);
        try {
            loop.run(UserMessage.of("inspect"));
            assertTrue(loop.hasPendingHITL());
            assertEquals(0, executions.get());
        } finally {
            loop.disposeCutinPlugins();
        }
    }

    @Test
    void mixedBatchWaitsForApprovalBeforeExecutingAnyTool() throws Exception {
        AtomicInteger executions = new AtomicInteger();
        ONode batch = calls("read", "{}");
        batch.add(calls("write", "{}").get(0));
        AgentLoop loop = loop(batch, tool("read", executions), tool("write", executions));
        try {
            loop.run(UserMessage.of("inspect then edit"));
            assertTrue(loop.hasPendingHITL());
            assertEquals(0, executions.get());
            loop.approveHITL();
            assertEquals("done", loop.run(null));
            assertEquals(2, executions.get());
        } finally {
            loop.disposeCutinPlugins();
        }
    }

    @Test
    void readOnlyQueriesDoNotInvokeConfiguredValidator() throws Exception {
        AtomicInteger executions = new AtomicInteger();
        AtomicInteger validations = new AtomicInteger();
        AgentLoop loop = loop(calls("read", "{}"), tool("read", executions));
        loop.setToolCallValidator(ToolCallValidator.forProvider(TestLoopraProvider.builder().call(request -> {
            validations.incrementAndGet();
            return TestLoopraProvider.response("{\"allow\":false,\"requiresHuman\":false,\"reason\":\"unused\"}");
        }).build(), Paths.get(".")));
        try {
            assertEquals("done", loop.run(UserMessage.of("inspect")));
            assertEquals(1, executions.get());
            assertEquals(0, validations.get());
        } finally {
            loop.disposeCutinPlugins();
        }
    }

    @Test
    void readOnlyExemptionStillHonorsMandatorySandboxApproval() throws Exception {
        FunctionToolDesc read = new FunctionToolDesc("read").description("read")
                .inputSchema("{\"type\":\"object\"}").returnType(String.class)
                .doHandle(args -> {
                    throw new HitlRequiredException("read", "SANDBOX_ESCAPE",
                            "outside workspace", Map.of("path", "../secret"));
                });
        AgentLoop loop = loop(calls("read", "{\"path\":\"../secret\"}"), read);
        try {
            loop.run(UserMessage.of("read"));
            assertTrue(loop.hasPendingHITL());
            assertTrue(loop.getHitlManager().hasSandboxPending());
        } finally {
            loop.disposeCutinPlugins();
        }
    }

    @Test
    void mixedBatchOnlySendsNonReadOnlyCallsToValidator() throws Exception {
        AtomicInteger executions = new AtomicInteger();
        AtomicInteger validations = new AtomicInteger();
        ONode batch = calls("read", "{}");
        batch.add(calls("write", "{}").get(0));
        AgentLoop loop = loop(batch, tool("read", executions), tool("write", executions));
        loop.setHitlMode("auto");
        loop.setToolCallValidator(ToolCallValidator.forProvider(TestLoopraProvider.builder().call(request -> {
            validations.incrementAndGet();
            assertTrue(request.messages().stream().anyMatch(message -> message.content() != null
                    && message.content().contains("\"tool\":\"write\"")));
            return TestLoopraProvider.response("{\"allow\":true,\"requiresHuman\":false,\"reason\":\"safe edit\"}");
        }).build(), Paths.get(".")));
        try {
            assertEquals("done", loop.run(UserMessage.of("inspect then edit")));
            assertEquals(1, validations.get());
            assertEquals(2, executions.get());
        } finally {
            loop.disposeCutinPlugins();
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"write", "edit", "memory"})
    void workspaceWritesAndProjectMemoryExecuteWithoutApprovalOrValidator(String name) throws Exception {
        AtomicInteger executions = new AtomicInteger();
        AtomicInteger validations = new AtomicInteger();
        AgentLoop loop = loop(calls(name, "{\"file_path\":\"src/new.txt\"}"), temporary, tool(name, executions));
        loop.setToolCallValidator(ToolCallValidator.forProvider(TestLoopraProvider.builder().call(request -> {
            validations.incrementAndGet();
            return TestLoopraProvider.response("{\"allow\":false,\"requiresHuman\":false,\"reason\":\"unused\"}");
        }).build(), temporary));
        try {
            assertEquals("done", loop.run(UserMessage.of("write inside the workspace")));
            assertEquals(1, executions.get());
            assertEquals(0, validations.get());
            assertFalse(loop.hasPendingHITL());
        } finally {
            loop.disposeCutinPlugins();
        }
    }

    @Test
    void outsideWriteWaitsForHumanAndApprovalDoesNotReplayItOnNextLocalWrite() throws Exception {
        Path root = Files.createDirectories(temporary.resolve("workspace"));
        Path outside = temporary.resolve("outside.txt");
        AtomicInteger requests = new AtomicInteger();
        AtomicInteger executions = new AtomicInteger();
        AtomicInteger validations = new AtomicInteger();
        FunctionToolDesc write = new FunctionToolDesc("write").description("write")
                .inputSchema("{\"type\":\"object\"}").returnType(String.class).doHandle(args -> {
                    executions.incrementAndGet();
                    Path target = root.resolve(String.valueOf(args.get("file_path")));
                    Files.writeString(target, String.valueOf(args.get("content")));
                    return "written";
                });
        // 模型按外部写入 -> 内部写入 -> 完成推进。
        TestLoopraProvider provider = TestLoopraProvider.builder().stream(request -> switch (requests.getAndIncrement()) {
            case 0 -> TestLoopraProvider.toolCallsStream(calls("write", ONode.ofBean(
                    Map.of("file_path", outside.toString(), "content", "outside")).toJson()));
            case 1 -> TestLoopraProvider.toolCallsStream(calls("write", "{\"file_path\":\"inside.txt\",\"content\":\"inside\"}"));
            default -> TestLoopraProvider.contentStream("done");
        }).build();
        ToolRegistry registry = new ToolRegistry() { @Override public void refresh() { } };
        registry.setEnvironment(SessionEnvironment.local(root));
        registry.setDisabledTools(Set.of());
        registry.register(write);
        AgentLoop loop = new AgentLoop(provider, registry,
                new ConversationContext(new PromptPrefix("test", new ONode().asArray())), null);
        loop.setHitlMode("approval");
        loop.setOutput(AgentOutput.NOOP);
        loop.setToolCallValidator(ToolCallValidator.forProvider(TestLoopraProvider.builder().call(request -> {
            validations.incrementAndGet();
            return TestLoopraProvider.response("{\"allow\":true,\"requiresHuman\":false,\"reason\":\"unused\"}");
        }).build(), root));
        try {
            loop.run(UserMessage.of("write files"));
            assertTrue(loop.getHitlManager().hasSandboxPending());
            assertFalse(Files.exists(outside));
            assertEquals(0, executions.get());
            assertEquals(0, validations.get());
            loop.approveHITL();
            assertEquals("done", loop.run(null));
            assertEquals("outside", Files.readString(outside));
            assertEquals("inside", Files.readString(root.resolve("inside.txt")));
            assertEquals(2, executions.get());
            assertFalse(loop.hasPendingHITL());
        } finally {
            loop.disposeCutinPlugins();
        }
    }

    @Test
    void fullyAutomaticModeExecutesOutsideWriteWithoutAnyReview() throws Exception {
        Path root = Files.createDirectories(temporary.resolve("workspace"));
        Path outside = temporary.resolve("outside.txt");
        AtomicInteger validations = new AtomicInteger();
        FunctionToolDesc write = new FunctionToolDesc("write").description("write")
                .inputSchema("{\"type\":\"object\"}").returnType(String.class).doHandle(args -> {
                    Files.writeString(Path.of(String.valueOf(args.get("file_path"))), "written");
                    return "written";
                });
        AgentLoop loop = loop(calls("write", ONode.ofBean(Map.of("file_path", outside.toString())).toJson()), root, write);
        loop.setHitlMode("free");
        loop.setToolCallValidator(ToolCallValidator.forProvider(TestLoopraProvider.builder().call(request -> {
            validations.incrementAndGet();
            return TestLoopraProvider.response("{\"allow\":false,\"requiresHuman\":true,\"reason\":\"unused\"}");
        }).build(), root));
        try {
            assertEquals("done", loop.run(UserMessage.of("write")));
            assertEquals("written", Files.readString(outside));
            assertEquals(0, validations.get());
            assertFalse(loop.hasPendingHITL());
        } finally { loop.disposeCutinPlugins(); }
    }

    private static AgentLoop loop(ONode calls, FunctionToolDesc... tools) {
        return loop(calls, Paths.get(".").toAbsolutePath(), tools);
    }

    private static AgentLoop loop(ONode calls, Path root, FunctionToolDesc... tools) {
        ToolRegistry registry = new ToolRegistry() {
            @Override
            public void refresh() { }
        };
        registry.setEnvironment(SessionEnvironment.local(root));
        registry.setDisabledTools(Set.of());
        for (FunctionToolDesc tool : tools) registry.register(tool);
        AgentLoop loop = new AgentLoop(TestLoopraProvider.toolCallsFirstThenAnswer(calls, "done"), registry,
                new ConversationContext(new PromptPrefix("test", new ONode().asArray())), null);
        loop.setHitlMode("approval");
        loop.setOutput(AgentOutput.NOOP);
        return loop;
    }

    private static FunctionToolDesc tool(String name, AtomicInteger executions) {
        return new FunctionToolDesc(name).description(name).inputSchema("{\"type\":\"object\"}")
                .returnType(String.class).doHandle(args -> {
                    executions.incrementAndGet();
                    return "ok";
                });
    }

    private static ONode calls(String name, String arguments) {
        ONode calls = new ONode().asArray();
        ONode call = calls.addNew();
        call.set("id", "call-" + name);
        call.getOrNew("function").set("name", name);
        call.getOrNew("function").set("arguments", arguments);
        return calls;
    }
}
