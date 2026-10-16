package site.sorghum.loopra.web.common;

import org.junit.jupiter.api.Test;
import site.sorghum.loopra.bin.model.ModelPriceProvider;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

class UsageCostCalculatorTest {

    @Test
    void separatesUncachedInputCachedInputAndOutputWithoutDoubleCharging() {
        var cost = UsageCostCalculator.calculate(Map.of("input", 2.0, "cache", 0.5, "output", 8.0),
                1_000_000, 250_000, 200_000);
        assertEquals(1.6, cost.inputCost(), 1e-10);
        assertEquals(0.1, cost.cacheCost(), 1e-10);
        assertEquals(2, cost.outputCost(), 1e-10);
        assertEquals(3.7, cost.totalCost(), 1e-10);
        assertTrue(cost.hasPrice());
    }

    @Test
    void zeroPriceIsKnownAndOverridesProviderMetadata() {
        ModelPriceProvider provider = provider(model -> { fail("configured zero rates must take precedence"); return null; });
        Map<String, Double> free = Map.of("input", 0.0, "cache", 0.0, "output", 0.0);
        var price = UsageCostCalculator.resolvePrice(Map.of("free", free), "free", provider);
        var cost = UsageCostCalculator.calculate(price, 1_000_000, 1_000_000, 0);
        assertTrue(cost.hasPrice());
        assertEquals(0, cost.totalCost());
        assertFalse(UsageCostCalculator.calculate(null, 1_000_000, 1_000_000, 0).hasPrice());
    }

    @Test
    void missingAndEmptyConfigurationBothFallBackToMetadata() {
        AtomicInteger calls = new AtomicInteger();
        Map<String, Double> price = Map.of("input", 2.0);
        ModelPriceProvider provider = provider(model -> { calls.incrementAndGet(); return price; });
        assertSame(price, UsageCostCalculator.resolvePrice(null, "model", provider));
        assertSame(price, UsageCostCalculator.resolvePrice(Map.of("model", Map.of()), "model", provider));
        assertEquals(2, calls.get());
        assertNull(UsageCostCalculator.resolvePrice(Map.of(), " ", provider));
        assertEquals(2, calls.get());
    }

    @Test
    void oneFailedProviderLookupDoesNotPreventPricingOtherModels() {
        ModelPriceProvider provider = provider(model -> {
            if (model.equals("broken")) throw new IllegalStateException("metadata unavailable");
            return Map.of("input", 2.0);
        });
        assertNull(UsageCostCalculator.resolvePrice(Map.of(), "broken", provider));
        assertEquals(Map.of("input", 2.0), UsageCostCalculator.resolvePrice(Map.of(), "working", provider));
    }

    @Test
    void costsAreAggregatedBeforeRounding() {
        var one = UsageCostCalculator.calculate(Map.of("input", 1.0), 40, 0, 0);
        assertEquals(0, UsageCostCalculator.round4(one.totalCost()));
        assertEquals(0.0001, UsageCostCalculator.round4(one.plus(one).totalCost()));
        assertTrue(one.plus(UsageCostCalculator.CostBreakdown.UNPRICED).hasPrice());
    }

    @Test
    void invalidCountersCannotProduceNegativeCostsOrChargeMoreCacheThanInput() {
        Map<String, Double> price = Map.of("input", 2.0, "cache", 0.5, "output", 8.0);
        assertEquals(0, UsageCostCalculator.calculate(price, -1, -1, -1).totalCost());
        var cost = UsageCostCalculator.calculate(price, 100, 0, 1000);
        assertEquals(0, cost.inputCost());
        assertEquals(0.00005, cost.cacheCost());
    }

    @Test
    void invalidRateFieldsDoNotProduceNaNOrInfiniteTotals() {
        Map<String, Double> price = new HashMap<>();
        price.put("input", null);
        price.put("cache", Double.NaN);
        price.put("output", Double.POSITIVE_INFINITY);
        assertEquals(0, UsageCostCalculator.calculate(price, 100, 100, 50).totalCost());
        assertEquals(0, UsageCostCalculator.calculate(Map.of("input", -2.0), 100, 0, 0).totalCost());
    }

    private static ModelPriceProvider provider(java.util.function.Function<String, Map<String, Double>> lookup) {
        return new ModelPriceProvider() {
            @Override public Map<String, Double> getModelPrice(String model) { return lookup.apply(model); }
            @Override public Map<String, Double> _getModelPrice(String model) { return lookup.apply(model); }
        };
    }
}
