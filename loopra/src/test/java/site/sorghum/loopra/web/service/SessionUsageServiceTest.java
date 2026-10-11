package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.loopra.bin.agent.core.LoopraAgent;
import site.sorghum.loopra.bin.agent.environment.SessionEnvironment;
import site.sorghum.loopra.bin.agent.prompt.PromptPrefix;
import site.sorghum.loopra.bin.config.LoopraConfig;
import site.sorghum.loopra.bin.model.ModelPriceProvider;
import site.sorghum.loopra.bin.model.TestLoopraProvider;
import site.sorghum.loopra.bin.session.JsonlSessionStore;
import site.sorghum.loopra.bin.tool.ToolRegistry;
import site.sorghum.loopra.bin.tool.ToolSystemInitializer.ToolSystem;
import site.sorghum.loopra.web.model.UsageDTO;

import java.nio.file.Path;
import java.util.Map;
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
