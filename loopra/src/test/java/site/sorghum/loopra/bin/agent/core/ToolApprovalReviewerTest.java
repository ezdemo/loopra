package site.sorghum.loopra.bin.agent.core;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.noear.snack4.ONode;
import org.noear.solon.ai.chat.tool.FunctionToolDesc;
import site.sorghum.loopra.bin.agent.context.ConversationContext;
import site.sorghum.loopra.bin.agent.environment.SessionEnvironment;
import site.sorghum.loopra.bin.agent.prompt.PromptPrefix;
import site.sorghum.loopra.bin.agent.spi.AgentConfig;
import site.sorghum.loopra.bin.model.TestLoopraProvider;
import site.sorghum.loopra.bin.tool.ToolRegistry;

import java.nio.file.Path;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

class ToolApprovalReviewerTest {
    @TempDir Path workspace;

    @ParameterizedTest
    @ValueSource(strings = {"approval", "auto"})
    void readOnlyStageShortCircuitsWorkspaceAiAndHumanReview(String mode) {
        AgentLoop loop = loop(mode, List.of());
        AtomicInteger validations = new AtomicInteger();
        loop.setToolCallValidator(validator(validations, false));
        try {
            var decision = loop.toolApprovalReviewer().review(calls("read", "{}"));
            assertTrue(decision.approved());
            assertEquals("read-only", decision.reviewer());
            assertEquals(0, validations.get());
        } finally { loop.disposeCutinPlugins(); }
    }

    @ParameterizedTest
    @ValueSource(strings = {"approval", "auto"})
    void workspaceStageOnlyReceivesCallsNotApprovedAsReadOnly(String mode) {
        AgentLoop loop = loop(mode, List.of());
        AtomicInteger validations = new AtomicInteger();
        loop.setToolCallValidator(validator(validations, false));
        ONode batch = calls("read", "{}");
        batch.add(calls("write", "{\"file_path\":\"new.txt\"}").get(0));
        try {
            var decision = loop.toolApprovalReviewer().review(batch);
            assertTrue(decision.approved());
            assertEquals("workspace", decision.reviewer());
            assertEquals(0, validations.get());
            assertEquals(2, batch.getArray().size(), "Review must not remove calls from the executable batch");
        } finally { loop.disposeCutinPlugins(); }
    }

    @ParameterizedTest
    @ValueSource(strings = {"approval", "auto"})
    void boundaryStageInspectsWholeBatchBeforeAnyAiCall(String mode) {
        AgentLoop loop = loop(mode, List.of("*"));
        AtomicInteger validations = new AtomicInteger();
        loop.setToolCallValidator(validator(validations, true));
        ONode batch = calls("bash", "{\"command\":\"unknown-command\"}");
        batch.add(calls("write", "{\"file_path\":\"../outside.txt\"}").get(0));
        try {
            var decision = loop.toolApprovalReviewer().review(batch);
            assertEquals(ToolApprovalReviewer.Verdict.SANDBOX, decision.verdict());
            assertEquals("boundary", decision.reviewer());
            assertEquals(0, validations.get());
        } finally { loop.disposeCutinPlugins(); }
    }

    @Test
    void aiApprovalStopsBeforeHumanFallbackButAiDenialReturnsHumanDecision() {
        AgentLoop loop = loop("auto", List.of());
        AtomicInteger validations = new AtomicInteger();
        ONode batch = calls("bash", "{\"command\":\"unknown-command\"}");
        try {
            loop.setToolCallValidator(validator(validations, true));
            var approved = loop.toolApprovalReviewer().review(batch);
            assertTrue(approved.approved());
            assertEquals("ai", approved.reviewer());
            loop.setToolCallValidator(validator(validations, false));
            var manual = loop.toolApprovalReviewer().review(batch);
            assertEquals(ToolApprovalReviewer.Verdict.HUMAN, manual.verdict());
            assertEquals("ai", manual.reviewer());
            assertTrue(manual.reason().contains("交由人工决定"));
            assertEquals(2, validations.get());
        } finally { loop.disposeCutinPlugins(); }
    }

    @Test
    void noAutomaticRuleFallsThroughToFinalHumanStage() {
        AgentLoop loop = loop("approval", List.of());
        try {
            var decision = loop.toolApprovalReviewer().review(calls("bash", "{\"command\":\"unknown-command\"}"));
            assertEquals(ToolApprovalReviewer.Verdict.HUMAN, decision.verdict());
            assertEquals("human", decision.reviewer());
        } finally { loop.disposeCutinPlugins(); }
    }

    @Test
    void malformedAiResponseAlsoReturnsHumanDecision() {
        AgentLoop loop = loop("auto", List.of());
        loop.setToolCallValidator(ToolCallValidator.forProvider(TestLoopraProvider.returningCall("not JSON"), workspace));
        try {
            var decision = loop.toolApprovalReviewer().review(calls("bash", "{\"command\":\"unknown-command\"}"));
            assertEquals(ToolApprovalReviewer.Verdict.HUMAN, decision.verdict());
            assertEquals("ai", decision.reviewer());
            assertTrue(decision.reason().contains("无法解析"));
        } finally { loop.disposeCutinPlugins(); }
    }

    @Test
    void autoModeUsesSameLocalRulesAndDoesNotLetLegacyWhitelistSkipAi() {
        AgentLoop loop = loop("auto", List.of("*"));
        AtomicInteger validations = new AtomicInteger();
        loop.setToolCallValidator(validator(validations, true));
        try {
            assertTrue(loop.toolApprovalReviewer().review(calls("read", "{}")).approved());
            assertTrue(loop.toolApprovalReviewer().review(calls("write", "{\"file_path\":\"new.txt\"}")).approved());
            assertEquals(0, validations.get());
            var decision = loop.toolApprovalReviewer().review(calls("bash", "{\"command\":\"unknown-command\"}"));
            assertEquals("ai", decision.reviewer());
            assertTrue(decision.approved());
            assertEquals(1, validations.get());
        } finally { loop.disposeCutinPlugins(); }
    }

    @Test
    void freeModeSkipsEveryReviewIncludingOutsideWorkspace() {
        AgentLoop loop = loop("free", List.of());
        AtomicInteger validations = new AtomicInteger();
        loop.setToolCallValidator(validator(validations, false));
        try {
            ONode batch = calls("bash", "{\"command\":\"unknown-command\"}");
            batch.add(calls("write", "{\"file_path\":\"../outside.txt\"}").get(0));
            var decision = loop.toolApprovalReviewer().review(batch);
            assertTrue(decision.approved());
            assertEquals("mode", decision.reviewer());
            assertEquals(0, validations.get());
        } finally { loop.disposeCutinPlugins(); }
    }

    @Test
    void approvalModeSkipsAiEvenWhenConfiguredAiWouldApprove() {
        AgentLoop loop = loop("approval", List.of("*"));
        AtomicInteger validations = new AtomicInteger();
        loop.setToolCallValidator(validator(validations, true));
        try {
            var decision = loop.toolApprovalReviewer().review(calls("bash", "{\"command\":\"unknown-command\"}"));
            assertEquals(ToolApprovalReviewer.Verdict.HUMAN, decision.verdict());
            assertEquals("human", decision.reviewer());
            assertEquals(0, validations.get());
        } finally { loop.disposeCutinPlugins(); }
    }

    @Test
    void switchingToApprovalWhileAiRunsDefersToHumanInsteadOfUsingAiApproval() {
        AgentLoop loop = loop("auto", List.of());
        AtomicInteger validations = new AtomicInteger();
        loop.setToolCallValidator(ToolCallValidator.forProvider(TestLoopraProvider.builder().call(request -> {
            validations.incrementAndGet();
            loop.setHitlMode("approval");
            return TestLoopraProvider.response("{\"allow\":true,\"requiresHuman\":false,\"reason\":\"allowed\"}");
        }).build(), workspace));
        try {
            var decision = loop.toolApprovalReviewer().review(calls("bash", "{\"command\":\"unknown-command\"}"));
            assertEquals(ToolApprovalReviewer.Verdict.HUMAN, decision.verdict());
            assertEquals("mode", decision.reviewer());
            assertEquals(1, validations.get());
            loop.toolApprovalReviewer().review(calls("bash", "{\"command\":\"unknown-command\"}"));
            assertEquals(1, validations.get());
        } finally { loop.disposeCutinPlugins(); }
    }

    private ToolCallValidator validator(AtomicInteger validations, boolean allow) {
        return ToolCallValidator.forProvider(TestLoopraProvider.builder().call(request -> {
            validations.incrementAndGet();
            return TestLoopraProvider.response("{\"allow\":" + allow
                    + ",\"requiresHuman\":false,\"reason\":\"review result\"}");
        }).build(), workspace);
    }

    private AgentLoop loop(String mode, List<String> whitelist) {
        ToolRegistry registry = new ToolRegistry() { @Override public void refresh() { } };
        registry.setDisabledTools(Set.of());
        registry.setEnvironment(SessionEnvironment.local(workspace));
        for (String name : List.of("read", "write", "bash", "workspace_read")) {
            registry.register(new FunctionToolDesc(name).description(name).inputSchema("{\"type\":\"object\"}")
                    .returnType(String.class).doHandle(args -> "unused"));
        }
        AgentLoop loop = new AgentLoop(TestLoopraProvider.returning("unused"), registry,
                new ConversationContext(new PromptPrefix("test", new ONode().asArray())), new Config(whitelist));
        loop.setHitlMode(mode);
        return loop;
    }

    private static ONode calls(String name, String arguments) {
        ONode calls = new ONode().asArray();
        ONode call = calls.addNew();
        call.set("id", "call-" + name);
        call.getOrNew("function").set("name", name);
        call.getOrNew("function").set("arguments", arguments);
        return calls;
    }

    private record Config(List<String> autoWhitelist) implements AgentConfig {
        @Override public int maxContextChars() { return 200_000; }
        @Override public int keepTailChars() { return 80_000; }
        @Override public int toolTimeoutSec() { return 30; }
        @Override public int subAgentTimeoutSec() { return 30; }
        @Override public int maxSelfCorrectionAttempts() { return 5; }
        @Override public int stormWindowSize() { return 6; }
        @Override public int stormThreshold() { return 3; }
        @Override public String validationModel() { return ""; }
        @Override public Channel validationModelChannel() { return null; }
    }
}
