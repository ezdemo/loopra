package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.loopra.bin.model.ModelPriceProvider;
import site.sorghum.loopra.web.model.DashboardDTO;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

class DashboardServiceTest {

    private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-10-11T08:00:00Z"), ZoneId.of("Asia/Shanghai"));
    @TempDir Path directory;

    @Test
    void dateWindowAppliesToDailyModelAndRequestTotals() throws Exception {
        Path file = log(List.of(
                record("2026-10-09T08:00:00Z", "too-old", 100, 20, 0),
                record("2026-10-10T08:00:00Z", "current", 100, 20, 10),
                record("2026-10-11T08:00:00Z", "current", 200, 30, 20),
                record("2026-10-12T08:00:00Z", "future", 9000, 9000, 0),
                "invalid json"));
        DashboardDTO result = service(file, Map.of("current", Map.of("input", 1.0)), null).getDashboard(2);
        assertEquals(2, result.totalRequests());
        assertEquals(300, result.totalPromptTokens());
        assertEquals(50, result.totalCompletionTokens());
        assertEquals(30, result.totalCacheHit());
        assertEquals(2, result.activeDays());
        assertEquals(List.of("2026-10-10", "2026-10-11"), result.dailyStats().stream().map(DashboardDTO.DailyStat::date).toList());
        assertEquals(1, result.modelStats().size());
        assertEquals("current", result.modelStats().get(0).model());
        assertEquals(2, result.modelStats().get(0).requests());
    }

    @Test
    void totalsKeepPrecisionAcrossDaysInsteadOfAddingRoundedDailyCosts() throws Exception {
        Path file = log(List.of(record("2026-10-10T08:00:00Z", "tiny", 40, 0, 0),
                record("2026-10-11T08:00:00Z", "tiny", 40, 0, 0)));
        DashboardDTO result = service(file, Map.of("tiny", Map.of("input", 1.0)), null).getDashboard(2);
        assertTrue(result.dailyStats().stream().allMatch(day -> day.cost() == 0));
        assertEquals(0.0001, result.totalCost());
        assertEquals(result.totalCost(), result.modelStats().get(0).cost());
    }

    @Test
    void emptyConfiguredPriceFallsBackOncePerModelAndExplicitFreePriceIsPreserved() throws Exception {
        Path file = log(List.of(record("2026-10-10T08:00:00Z", "paid", 1_000_000, 0, 0),
                record("2026-10-11T08:00:00Z", "paid", 1_000_000, 0, 0),
                record("2026-10-11T08:00:00Z", "free", 1_000_000, 0, 0)));
        AtomicInteger calls = new AtomicInteger();
        ModelPriceProvider provider = provider(model -> {
            assertEquals("paid", model);
            calls.incrementAndGet();
            return Map.of("input", 2.0);
        });
        DashboardDTO result = service(file, Map.of("paid", Map.of(), "free", Map.of("input", 0.0)), provider)
                .getDashboard(2);
        assertEquals(4, result.totalCost());
        assertEquals(1, calls.get());
        assertEquals(2.0, result.modelPrices().get("paid").get("input"));
        assertEquals(0, result.modelPrices().get("free").get("input"));
    }

    @Test
    void failedPriceLookupKeepsTokensAndCostsForOtherModels() throws Exception {
        Path file = log(List.of(record("2026-10-11T08:00:00Z", "broken", 100, 0, 0),
                record("2026-10-11T08:00:00Z", "good", 1_000_000, 0, 0)));
        DashboardDTO result = service(file, Map.of(), provider(model -> {
            if (model.equals("broken")) throw new IllegalStateException("metadata failed");
            return Map.of("input", 2.0);
        })).getDashboard(1);
        assertEquals(1_000_100, result.totalPromptTokens());
        assertEquals(2, result.totalRequests());
        assertEquals(2, result.totalCost());
        assertEquals(2, result.modelStats().size());
    }

    @Test
    void usesConfiguredTimezoneAtTheDateBoundary() throws Exception {
        Path file = log(List.of(record("2026-10-10T16:30:00Z", "model", 100, 0, 0)));
        DashboardDTO result = service(file, Map.of(), null).getDashboard(1);
        assertEquals(1, result.totalRequests());
        assertEquals("2026-10-11", result.dailyStats().get(0).date());
    }

    @Test
    void missingLogsProduceCompleteEmptyDateSeriesAndDaysAreBounded() {
        DashboardService service = service(directory.resolve("missing.jsonl"), Map.of(), null);
        assertEquals(30, service.getDashboard(0).dailyStats().size());
        assertEquals(365, service.getDashboard(1000).dailyStats().size());
        DashboardDTO result = service.getDashboard(2);
        assertEquals(0, result.totalRequests());
        assertEquals(0, result.activeDays());
        assertTrue(result.modelStats().isEmpty());
    }

    private Path log(List<String> records) throws Exception {
        Path file = directory.resolve("usage.jsonl");
        Files.write(file, records);
        return file;
    }

    private static String record(String time, String model, long prompt, long completion, long cached) {
        return "{\"ts\":" + Instant.parse(time).toEpochMilli() + ",\"model\":\"" + model
                + "\",\"prompt\":" + prompt + ",\"completion\":" + completion
                + ",\"cacheHit\":" + cached + ",\"cacheMiss\":" + (prompt - cached) + "}";
    }

    private static DashboardService service(Path path, Map<String, Map<String, Double>> prices, ModelPriceProvider provider) {
        return new DashboardService(path, CLOCK, () -> prices, () -> provider);
    }

    private static ModelPriceProvider provider(java.util.function.Function<String, Map<String, Double>> lookup) {
        return new ModelPriceProvider() {
            @Override public Map<String, Double> getModelPrice(String model) { return lookup.apply(model); }
            @Override public Map<String, Double> _getModelPrice(String model) { return lookup.apply(model); }
        };
    }
}
