package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.loopra.bin.agent.core.LoopraAgent;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.model.ToolCallEntry;
import site.sorghum.loopra.bin.agent.environment.SessionEnvironment;
import site.sorghum.loopra.bin.agent.prompt.PromptPrefix;
import site.sorghum.loopra.bin.config.LoopraConfig;
import site.sorghum.loopra.bin.config.ConfigService;
import site.sorghum.loopra.bin.model.ModelPriceProvider;
import site.sorghum.loopra.bin.model.TestLoopraProvider;
import site.sorghum.loopra.bin.session.JsonlSessionStore;
import site.sorghum.loopra.bin.session.SessionStore;
import site.sorghum.loopra.bin.tool.ToolRegistry;
import site.sorghum.loopra.bin.tool.ToolSystemInitializer.ToolSystem;
import site.sorghum.loopra.web.model.UsageDTO;

import java.nio.file.Path;
import java.util.Map;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

class SessionUsageServiceTest {

    @TempDir Path home;
    private String previousHome;
    private StoredUsage store;
    private LoopraAgent agent;

    @BeforeEach
    void createHistoricalAgent() {
        previousHome = System.getProperty("user.home");
        System.setProperty("user.home", home.toString());
        ConfigService.reload();
        ToolRegistry tools = new ToolRegistry().setDisabledTools(Set.of());
        tools.setEnvironment(SessionEnvironment.local(home.resolve("project")));
        store = new StoredUsage(home.resolve("sessions"));
        agent = LoopraAgent.builder().config(LoopraConfig.load())
                .environment(SessionEnvironment.local(home.resolve("project")))
                .modelProvider(TestLoopraProvider.builder().model("current").build())
                .sessionStore(store)
                .toolSystem(new ToolSystem(tools, new PromptPrefix("test", tools.toOpenAiTools())))
                .buildLightweight();
        agent.bindSession("session");
    }

    @AfterEach
    void releaseHistoricalAgent() {
        agent.dispose();
        store.shutdown();
        System.setProperty("user.home", previousHome);
    }

    @Test
    void legacyUsageHasSeparateInputCacheAndOutputCosts() {
        UsageDTO result = service(Map.of("current", rates(2, 0.5, 8)), null).read(agent);
        assertEquals(1_000_000, result.promptTokens());
        assertEquals(250_000, result.completionTokens());
        assertEquals(200_000, result.cacheHit());
        assertEquals(800_000, result.cacheMiss());
        assertEquals(100_000, result.lastPromptTokens());
        assertEquals(1_250_000, result.totalTokens());
        assertEquals(1.6, result.inputCost());
        assertEquals(0.1, result.cacheCost());
        assertEquals(2, result.outputCost());
        assertEquals(3.7, result.totalCost());
        assertEquals("current", result.model());
        assertEquals("CNY", result.currency());
        assertTrue(result.hasPrice());
        assertNotNull(result.contextEstimate());
    }

    @Test
    void switchedModelsArePricedByTheirOwnUsageAndRates() {
        store.perModel = Map.of("first", new long[]{500_000, 100_000, 100_000, 400_000},
                "second", new long[]{500_000, 150_000, 100_000, 400_000});
        agent.bindSession("session");
        UsageDTO result = service(Map.of("first", rates(2, 0.5, 8), "second", rates(4, 1, 10),
                "current", rates(99, 99, 99)), null).read(agent);
        assertEquals(2.4, result.inputCost());
        assertEquals(0.15, result.cacheCost());
        assertEquals(2.3, result.outputCost());
        assertEquals(4.85, result.totalCost());
        assertEquals("current", result.model());
    }

    @Test
    void legacyFreeModelIsKnownPricedEvenWhenTotalCostIsZero() {
        UsageDTO result = service(Map.of("current", rates(0, 0, 0)), null).read(agent);
        assertTrue(result.hasPrice());
        assertEquals("CNY", result.currency());
        assertEquals(0, result.totalCost());
    }

    @Test
    void failedModelMetadataDoesNotDiscardOtherModelsCostsOrAnyTokens() {
        store.perModel = Map.of("broken", new long[]{500_000, 100_000, 0, 500_000},
                "good", new long[]{500_000, 150_000, 0, 500_000});
        agent.bindSession("session");
        ModelPriceProvider provider = new ModelPriceProvider() {
            @Override public Map<String, Double> getModelPrice(String model) {
                if (model.equals("broken")) throw new IllegalStateException("metadata failed");
                return rates(2, 0, 0);
            }
            @Override public Map<String, Double> _getModelPrice(String model) { return getModelPrice(model); }
        };
        UsageDTO result = service(Map.of(), provider).read(agent);
        assertEquals(1, result.totalCost());
        assertEquals(1_000_000, result.promptTokens());
        assertTrue(result.hasPrice());
    }

    @Test
    void failedConfigurationReadStillReturnsTokensModelAndContext() {
        UsageDTO result = new SessionUsageService(() -> { throw new IllegalStateException("config unavailable"); },
                () -> null, () -> "fallback").read(agent);
        assertEquals(1_000_000, result.promptTokens());
        assertEquals("current", result.model());
        assertNotNull(result.contextEstimate());
        assertFalse(result.hasPrice());
        assertNull(result.currency());
        assertEquals(0, result.totalCost());
    }

    @Test
    void acpContextUsageKeepsTheAgentsRealWindowAndCostCurrency() {
        UsageDTO result = service(Map.of(), null).readAcp(
                new site.sorghum.loopra.bin.session.SessionStore.AcpUsage(3210, 200000, 0.0456, "USD", "claude-test"));
        assertEquals(3210, result.lastPromptTokens());
        assertEquals(200000, result.maxContextTokens());
        assertEquals(0, result.totalTokens());
        assertEquals("claude-test", result.model());
        assertTrue(result.hasPrice());
        assertEquals(0.0456, result.totalCost(), 1e-9);
        assertEquals("USD", result.currency());
        assertNull(result.contextEstimate());
        // ACP does not report cumulative token counters or a cost breakdown.
        assertEquals(0, result.promptTokens());
        assertEquals(0, result.completionTokens());
    }

    @Test
    void absentAcpUsageFallsBackToNoServerNumbersInsteadOfAStaleWindow() {
        UsageDTO missing = service(Map.of(), null).readAcp(null);
        assertEquals(0, missing.lastPromptTokens());
        assertEquals(0, missing.maxContextTokens());
        assertFalse(missing.hasPrice());
        UsageDTO invalid = service(Map.of(), null).readAcp(
                new site.sorghum.loopra.bin.session.SessionStore.AcpUsage(100, 0, null, null, null));
        assertEquals(0, invalid.maxContextTokens());
    }

    @Test
    void acpReportedTotalAndWindowKeepPriorityOverTranscriptEstimate() throws Exception {
        store.setAcpUsage("session", new SessionStore.AcpUsage(375000, 475000, 0.05, "USD", "external"));
        store.append(ChatMessage.ofUser("用户问题"));
        store.append(ChatMessage.assistant("回答", List.of(new ToolCallEntry("call", "read", "{}")), null));
        store.append(ChatMessage.tool("call", "工具结果"));
        UsageDTO result = service(Map.of(), null).readAcp(store, "session");
        assertEquals(375000, result.lastPromptTokens());
        assertEquals(475000, result.maxContextTokens());
        assertEquals("agent", result.contextSource());
        assertEquals("transcript", result.contextEstimateScope());
        assertTrue(result.contextEstimate().userTokens() > 0);
        assertTrue(result.contextEstimate().assistantTokens() > 0);
        assertTrue(result.contextEstimate().toolResultTokens() > 0);
        assertEquals(0, result.contextEstimate().systemTokens());
        assertEquals(0, result.contextEstimate().toolDefinitionTokens());
        assertNotEquals(result.lastPromptTokens(), result.contextEstimate().totalTokens());
        assertEquals(0.05, result.totalCost());
    }

    @Test
    void acpWithoutUsageEstimatesStoredTranscriptAndResolvesItsOwnModelWindow() throws Exception {
        store.setAgentConfig("session", Map.of("model", "\"external\""));
        store.append(ChatMessage.ofUser("这是已保存的会话"));
        SessionUsageService service = new SessionUsageService(() -> Map.of(), () -> null,
                () -> { throw new AssertionError("must not use the Native default model"); },
                model -> "external".equals(model) ? 200000 : 0);
        UsageDTO result = service.readAcp(store, "session");
        assertEquals("external", result.model());
        assertEquals(200000, result.maxContextTokens());
        assertEquals("loopra", result.contextSource());
        assertTrue(result.contextEstimate().totalTokens() > 0);
        assertEquals(0, result.lastPromptTokens());
        assertFalse(result.hasPrice());
    }

    @Test
    void acpZeroUsageRemainsAuthoritativeEvenWithANonemptyTranscript() throws Exception {
        store.setAcpUsage("session", new SessionStore.AcpUsage(0, 200000, null, null, null));
        store.append(ChatMessage.ofUser("压缩之前的历史"));
        UsageDTO result = service(Map.of(), null).readAcp(store, "session");
        assertEquals("agent", result.contextSource());
        assertEquals(0, result.lastPromptTokens());
        assertTrue(result.contextEstimate().totalTokens() > 0);
    }

    @Test
    void acpUnknownWindowDoesNotBorrowTheNativeDefault() throws Exception {
        store.append(ChatMessage.ofUser("会话内容"));
        UsageDTO result = service(Map.of(), null).readAcp(store, "session");
        assertEquals(0, result.maxContextTokens());
        assertNull(result.model());
        assertTrue(result.contextEstimate().totalTokens() > 0);
    }

    @Test
    void acpTranscriptReadFailurePreservesReportedUsage() throws Exception {
        var unreadable = new JsonlSessionStore(home.resolve("unreadable")) {
            @Override public List<ChatMessage> load(String name) throws java.io.IOException {
                throw new java.io.IOException("unavailable");
            }
        };
        try {
            unreadable.setAcpUsage("session", new SessionStore.AcpUsage(3210, 200000, 0.04, "USD", "external"));
            UsageDTO result = service(Map.of(), null).readAcp(unreadable, "session");
            assertEquals(3210, result.lastPromptTokens());
            assertEquals("agent", result.contextSource());
            assertNull(result.contextEstimate());
            assertEquals(0.04, result.totalCost());
        } finally { unreadable.shutdown(); }
    }

    @Test
    void absentAgentReturnsAnEmptyViewWithoutReadingConfiguration() {
        UsageDTO result = new SessionUsageService(() -> { throw new AssertionError("unexpected config read"); },
                () -> { throw new AssertionError("unexpected provider read"); }, () -> "fallback").read(null);
        assertEquals(0, result.totalTokens());
        assertEquals(128000, result.maxContextTokens());
        assertNull(result.contextEstimate());
        assertNull(result.model());
        assertFalse(result.hasPrice());
    }

    @Test
    void fourCounterHistoricalUsageRestoresWithoutLastPromptTokens() {
        store.usage = new long[]{1_000_000, 250_000, 200_000, 800_000};
        agent.bindSession("session");
        UsageDTO result = service(Map.of("current", rates(2, 0.5, 8)), null).read(agent);
        assertEquals(0, result.lastPromptTokens());
        assertEquals(3.7, result.totalCost());
    }

    private static SessionUsageService service(Map<String, Map<String, Double>> prices, ModelPriceProvider provider) {
        return new SessionUsageService(() -> prices, () -> provider, () -> "fallback");
    }

    private static Map<String, Double> rates(double input, double cache, double output) {
        return Map.of("input", input, "cache", cache, "output", output);
    }

    private static final class StoredUsage extends JsonlSessionStore {
        private long[] usage = {1_000_000, 250_000, 200_000, 800_000, 100_000};
        private Map<String, long[]> perModel = Map.of();

        StoredUsage(Path path) { super(path); }
        @Override public long[] loadUsage(String name) { return usage.clone(); }
        @Override public Map<String, long[]> loadModelUsage(String name) { return perModel; }
    }
}
