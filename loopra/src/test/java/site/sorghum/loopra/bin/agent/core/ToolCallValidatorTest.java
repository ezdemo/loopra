package site.sorghum.loopra.bin.agent.core;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.noear.snack4.ONode;
import org.noear.solon.ai.chat.tool.FunctionToolDesc;
import site.sorghum.loopra.bin.agent.context.ConversationContext;
import site.sorghum.loopra.bin.agent.environment.SessionEnvironment;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.bin.agent.prompt.PromptPrefix;
import site.sorghum.loopra.bin.model.LoopraModelProvider;
import site.sorghum.loopra.bin.model.TestLoopraProvider;
import site.sorghum.loopra.bin.tool.ToolRegistry;
import site.sorghum.loopra.tool.AgentOutput;

import java.nio.file.Paths;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

class ToolCallValidatorTest {

    @Test
    void aiApprovalExecutesWithoutOpeningManualHitl() throws Exception {
        AtomicInteger validations = new AtomicInteger();
        AtomicInteger executions = new AtomicInteger();
        AgentLoop loop = loop("auto", toolCallingModel(toolCalls("bash", "{\"command\":\"mvn test\"}")),
                registryWith(tool("bash", args -> {
                    executions.incrementAndGet();
                    return "executed";
                })), ToolCallValidator.forProvider(reply(validations,
                        "```json\n{\"allow\":true,\"requiresHuman\":false,\"reason\":\"local test\"}\n```"), Paths.get(".")));

        String result = loop.run(UserMessage.of("run tests"));

        assertEquals("done", result);
        assertEquals(1, validations.get());
        assertEquals(1, executions.get());
        assertFalse(loop.getHitlManager().hasPendingHITL());
    }

    @Test
    void aiDenialDefersToHumanAndExecutesOnlyAfterApproval() throws Exception {
        AtomicInteger validations = new AtomicInteger();
        AtomicInteger executions = new AtomicInteger();
        AgentLoop loop = loop("auto", toolCallingModel(toolCalls("bash", "{\"command\":\"rm -rf /\"}")),
                registryWith(tool("bash", args -> {
                    executions.incrementAndGet();
                    return "executed";
                })), ToolCallValidator.forProvider(reply(validations,
                        "{\"allow\":false,\"requiresHuman\":false,\"reason\":\"destructive command\"}"), Paths.get(".")));

        String result = loop.run(UserMessage.of("delete files"));

        assertEquals(1, validations.get());
        assertEquals(0, executions.get());
        assertTrue(result.contains("AI 未批准"));
        assertTrue(result.contains("destructive command"));
        assertTrue(loop.getHitlManager().hasPendingHITL());
        loop.approveHITL();
        assertEquals("done", loop.run(null));
        assertEquals(1, executions.get());
        assertEquals(1, validations.get());
        assertFalse(loop.hasPendingHITL());
    }

    @Test
    void freeModeDoesNotInvokeAiApproval() throws Exception {
        AtomicInteger validations = new AtomicInteger();
        AtomicInteger executions = new AtomicInteger();
        AgentLoop loop = loop("free", toolCallingModel(toolCalls("bash", "{}")),
                registryWith(tool("bash", args -> {
                    executions.incrementAndGet();
                    return "executed";
                })), ToolCallValidator.forProvider(reply(validations,
                        "{\"allow\":false,\"requiresHuman\":false,\"reason\":\"should not be used\"}"), Paths.get(".")));

        String result = loop.run(UserMessage.of("run"));

        assertEquals("done", result);
        assertEquals(0, validations.get());
        assertEquals(1, executions.get());
    }

    @Test
    void approvalModeNeverCallsConfiguredValidatorBeforeOrAfterHumanApproval() throws Exception {
        AtomicInteger validations = new AtomicInteger();
        AtomicInteger executions = new AtomicInteger();
        AgentLoop loop = loop("approval", toolCallingModel(toolCalls("bash", "{\"command\":\"unknown-command\"}")),
                registryWith(tool("bash", args -> {
                    executions.incrementAndGet();
                    return "executed";
                })), ToolCallValidator.forProvider(reply(validations,
                        "{\"allow\":true,\"requiresHuman\":false,\"reason\":\"should not be used\"}"), Paths.get(".")));
        try {
            loop.run(UserMessage.of("run"));
            assertTrue(loop.hasPendingHITL());
            assertEquals(0, validations.get());
            assertEquals(0, executions.get());
            loop.approveHITL();
            assertEquals("done", loop.run(null));
            assertEquals(0, validations.get());
            assertEquals(1, executions.get());
        } finally { loop.disposeCutinPlugins(); }
    }

    @Test
    void humanCanRejectACommandThatAiDidNotApprove() throws Exception {
        AtomicInteger executions = new AtomicInteger();
        AtomicInteger validations = new AtomicInteger();
        AgentLoop loop = loop("auto", toolCallingModel(toolCalls("bash", "{\"command\":\"unknown-command\"}")),
                registryWith(tool("bash", args -> {
                    executions.incrementAndGet();
                    return "executed";
                })), ToolCallValidator.forProvider(reply(validations,
                        "{\"allow\":false,\"requiresHuman\":false,\"reason\":\"needs human judgment\"}"), Paths.get(".")));
        try {
            loop.run(UserMessage.of("run"));
            assertTrue(loop.hasPendingHITL());
            loop.denyHITL();
            assertTrue(loop.run(null).contains("用户拒绝"));
            assertEquals(0, executions.get());
            assertEquals(1, validations.get());
            assertFalse(loop.hasPendingHITL());
        } finally {
            loop.disposeCutinPlugins();
        }
    }

    @Test
    void sandboxEscapeIsDeferredToMandatoryHumanApproval() throws Exception {
        AtomicInteger validations = new AtomicInteger();
        AtomicInteger executions = new AtomicInteger();
        AgentLoop loop = loop("auto", toolCallingModel(toolCalls("write", "{\"path\":\"../secret\"}")),
                registryWith(tool("write", args -> {
                    executions.incrementAndGet();
                    return "executed";
                })), ToolCallValidator.forProvider(reply(validations,
                        "{\"allow\":false,\"requiresHuman\":true,\"reason\":\"outside workspace\"}"), Paths.get(".")));

        String result = loop.run(UserMessage.of("write outside workspace"));

        assertEquals(1, validations.get());
        assertEquals(0, executions.get());
        assertTrue(result.contains("outside workspace"));
        assertTrue(loop.getHitlManager().hasPendingHITL());
        assertTrue(loop.getHitlManager().hasSandboxPending());
    }

    @ParameterizedTest
    @ValueSource(strings = {"approval", "auto"})
    void missingValidationModelKeepsManualHitl(String mode) throws Exception {
        AtomicInteger executions = new AtomicInteger();
        AgentLoop loop = loop(mode, toolCallingModel(toolCalls("bash", "{}")),
                registryWith(tool("bash", args -> {
                    executions.incrementAndGet();
                    return "executed";
                })), ToolCallValidator.fromConfig(null, Paths.get(".")));

        String result = loop.run(UserMessage.of("run"));

        assertTrue(result.contains("HITL"));
        assertTrue(loop.getHitlManager().hasPendingHITL());
        assertEquals(0, executions.get());
    }

    @Test
    void malformedValidatorResponseFailsClosed() {
        ToolCallValidator.Decision decision = ToolCallValidator.forProvider(reply("probably safe"), Paths.get("."))
                .validate("bash", "{}");

        assertFalse(decision.allowed());
        assertTrue(decision.reason().contains("无法解析校验模型结果"));
    }

    @Test
    void nonBooleanAllowValueFailsClosed() {
        ToolCallValidator.Decision decision = ToolCallValidator.forProvider(
                reply("{\"allow\":\"true\",\"requiresHuman\":false,\"reason\":\"wrong type\"}"), Paths.get("."))
                .validate("bash", "{}");

        assertFalse(decision.allowed());
        assertTrue(decision.reason().contains("allow 字段不是布尔值"));
    }

    @Test
    void validationModelFailureFallsBackToManualHitl() throws Exception {
        AtomicInteger executions = new AtomicInteger();
        AgentLoop loop = loop("auto", toolCallingModel(toolCalls("bash", "{\"command\":\"mvn test\"}")),
                registryWith(tool("bash", args -> {
                    executions.incrementAndGet();
                    return "executed";
                })), ToolCallValidator.forProvider(failingClient(new IllegalStateException("timeout")), Paths.get(".")));

        String result = loop.run(UserMessage.of("run tests"));

        // 校验失败时展示原因并等待人工决定。
        assertTrue(result.contains("HITL"), result);
        assertTrue(loop.getHitlManager().hasPendingHITL());
        assertEquals(0, executions.get());

        // 决策层面：failed 状态且携带校验失败原因
        ToolCallValidator.Decision decision = ToolCallValidator.forProvider(
                failingClient(new IllegalStateException("timeout")), Paths.get(".")).validate("bash", "{}");
        assertTrue(decision.failed());
        assertTrue(decision.reason().contains("校验模型调用失败"));
        assertTrue(decision.reason().contains("timeout"));
    }

    private static TestLoopraProvider failingClient(Exception failure) {
        return TestLoopraProvider.builder()
                .model("validator")
                .call(request -> {
                    throw new RuntimeException(failure);
                })
                .build();
    }

    private static AgentLoop loop(String hitlMode, LoopraModelProvider mainClient, ToolRegistry registry,
                                  ToolCallValidator validator) {
        ConversationContext context = new ConversationContext(
                new PromptPrefix("test", new ONode().asArray()));
        AgentLoop loop = new AgentLoop(mainClient, registry, context, null);
        loop.setHitlMode(hitlMode);
        loop.setToolCallValidator(validator);
        loop.setOutput(AgentOutput.NOOP);
        return loop;
    }

    private static TestLoopraProvider toolCallingModel(ONode toolCalls) {
        return TestLoopraProvider.toolCallsFirstThenAnswer(toolCalls, "done");
    }

    private static TestLoopraProvider reply(String content) {
        return reply(new AtomicInteger(), content);
    }

    private static TestLoopraProvider reply(AtomicInteger calls, String content) {
        return TestLoopraProvider.builder()
                .model("validator")
                .call(request -> {
                    calls.incrementAndGet();
                    return TestLoopraProvider.response(content);
                })
                .build();
    }

    private static ToolRegistry registryWith(FunctionToolDesc tool) {
        ToolRegistry registry = new ToolRegistry() {
            @Override
            public void refresh() {
                // 单元测试直接注册工具，不启动 Solon 容器。
            }
        };
        registry.setDisabledTools(Set.of());
        registry.setEnvironment(SessionEnvironment.local(Paths.get(".").toAbsolutePath()));
        registry.register(tool);
        return registry;
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
