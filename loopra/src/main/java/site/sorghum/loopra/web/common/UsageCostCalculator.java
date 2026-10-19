package site.sorghum.loopra.web.common;

import lombok.extern.slf4j.Slf4j;
import site.sorghum.loopra.bin.config.LoopraConfig;
import site.sorghum.loopra.bin.model.ModelPriceProvider;
import site.sorghum.loopra.web.service.ModelMetaPriceProvider;

import java.util.Collections;
import java.util.Map;

/**
 * Token 费用计算与价格选择，供会话用量和面板统计复用。
 *
 * @author Sorghum
 */
@Slf4j
public final class UsageCostCalculator {

    private UsageCostCalculator() {}

    /**
     * 计算单个模型的 Token 费用。
     *
     * @param prices     价格配置 map（model → {input, cache, output}，单位：元/百万 token）
     * @param model      模型名称
     * @param prompt     输入 token 数
     * @param completion 输出 token 数
     * @param cacheHit   缓存命中 token 数
     * @return 费用（元），无价格配置时返回 0
     */
    public static double calc(Map<String, Map<String, Double>> prices,
                              String model, long prompt, long completion, long cacheHit) {
        return calculate(resolvePrice(prices, model, ModelMetaPriceProvider.getInstance()),
                prompt, completion, cacheHit).totalCost();
    }

    /** 显式配置（包括零价）优先；缺失或空配置才查询提供者。单个模型查询失败不阻断其他模型。 */
    public static Map<String, Double> resolvePrice(Map<String, Map<String, Double>> prices,
                                                   String model, ModelPriceProvider provider) {
        if (model == null || model.isBlank()) return null;
        Map<String, Double> configured = prices == null ? null : prices.get(model);
        if (configured != null && !configured.isEmpty()) return configured;
        if (provider == null) return null;
        try {
            return provider.getModelPrice(model);
        } catch (RuntimeException exception) {
            log.warn("[usage] 查询模型价格失败: {}", model, exception);
            return null;
        }
    }

    /** 纯计算：输入已包含缓存命中量，费用先保留精度，汇总完成后再舍入。 */
    public static CostBreakdown calculate(Map<String, Double> price,
                                          long prompt, long completion, long cacheHit) {
        if (price == null || price.isEmpty()) return CostBreakdown.UNPRICED;
        long input = Math.max(0, prompt);
        long cached = Math.min(input, Math.max(0, cacheHit));
        return new CostBreakdown(
                (input - cached) / 1_000_000.0 * rate(price, "input"),
                cached / 1_000_000.0 * rate(price, "cache"),
                Math.max(0, completion) / 1_000_000.0 * rate(price, "output"), true);
    }

    private static double rate(Map<String, Double> price, String key) {
        Double value = price.get(key);
        return value != null && Double.isFinite(value) && value >= 0 ? value : 0;
    }

    public record CostBreakdown(double inputCost, double cacheCost, double outputCost, boolean hasPrice) {
        public static final CostBreakdown UNPRICED = new CostBreakdown(0, 0, 0, false);

        public double totalCost() {
            return inputCost + cacheCost + outputCost;
        }

        public CostBreakdown plus(CostBreakdown other) {
            return new CostBreakdown(inputCost + other.inputCost, cacheCost + other.cacheCost,
                    outputCost + other.outputCost, hasPrice || other.hasPrice);
        }
    }

    /**
     * 加载价格配置，失败时返回空 Map。
     */
    public static Map<String, Map<String, Double>> loadPrices() {
        try {
            LoopraConfig cfg = LoopraConfig.load();
            Map<String, Map<String, Double>> prices = cfg.price();
            return prices != null ? prices : Collections.emptyMap();
        } catch (Exception e) {
            return Collections.emptyMap();
        }
    }

    /**
     * 四舍五入到万分位。
     */
    public static double round4(double v) {
        return Math.round(v * 10000.0) / 10000.0;
    }
}
