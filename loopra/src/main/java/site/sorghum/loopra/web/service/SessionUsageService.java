package site.sorghum.loopra.web.service;

import lombok.extern.slf4j.Slf4j;
import site.sorghum.loopra.bin.agent.context.ContextTokenEstimate;
import site.sorghum.loopra.bin.agent.core.LoopraAgent;
import site.sorghum.loopra.bin.config.ConfigService;
import site.sorghum.loopra.bin.model.ModelPriceProvider;
import site.sorghum.loopra.bin.session.SessionStore;
import site.sorghum.loopra.web.common.UsageCostCalculator;
import site.sorghum.loopra.web.common.UsageCostCalculator.CostBreakdown;
import site.sorghum.loopra.web.model.UsageDTO;

import java.util.Map;
import java.util.function.Supplier;

/** 将已选择 Agent 的用量与上下文估算转换为查询视图；不创建或切换 Agent。 */
@Slf4j
final class SessionUsageService {

    private final Supplier<Map<String, Map<String, Double>>> prices;
    private final Supplier<ModelPriceProvider> priceProvider;
    private final Supplier<String> defaultModel;

    SessionUsageService() {
        this(() -> ConfigService.getConfig().price(), ModelMetaPriceProvider::getInstance,
                () -> ConfigService.getConfig().model());
    }

    SessionUsageService(Supplier<Map<String, Map<String, Double>>> prices,
                        Supplier<ModelPriceProvider> priceProvider, Supplier<String> defaultModel) {
        this.prices = prices;
        this.priceProvider = priceProvider;
        this.defaultModel = defaultModel;
    }

    UsageDTO read(LoopraAgent agent) {
        if (agent == null) {
            return new UsageDTO(0, 0, 0, 0, 0, 128000, 0,
                    null, false, 0, 0, 0, 0, null, null);
        }
        long[] usage = agent.getSessionUsage();
        String model = agent.getModel();
        CostBreakdown cost = CostBreakdown.UNPRICED;
        try {
            if (model == null) model = defaultModel.get();
            Map<String, Map<String, Double>> configured = prices.get();
            ModelPriceProvider provider = priceProvider.get();
            Map<String, long[]> perModel = agent.getModelUsage();
            if (perModel == null || perModel.isEmpty()) {
                cost = calculate(configured, provider, model, usage);
            } else {
                for (Map.Entry<String, long[]> entry : perModel.entrySet()) {
                    cost = cost.plus(calculate(configured, provider, entry.getKey(), entry.getValue()));
                }
            }
        } catch (RuntimeException exception) {
            // 计价失败不丢弃 token 数据或上下文估算，且不能发布未完成汇总的费用。
            cost = CostBreakdown.UNPRICED;
            log.warn("[usage] 计算会话费用失败: model={}", model, exception);
        }
        ContextTokenEstimate estimate = agent.getLastContextEstimate();
        if (estimate == null) estimate = agent.estimateCurrentContext();
        return new UsageDTO(usage[0], usage[1], usage[2], usage[3], usage.length > 4 ? usage[4] : 0,
                agent.getMaxContextTokens(), usage[0] + usage[1], model, cost.hasPrice(),
                UsageCostCalculator.round4(cost.inputCost()), UsageCostCalculator.round4(cost.cacheCost()),
                UsageCostCalculator.round4(cost.outputCost()), UsageCostCalculator.round4(cost.totalCost()),
                cost.hasPrice() ? "CNY" : null, estimate);
    }

    /**
     * 外部 ACP Agent 只上报上下文占用，不提供累计 token 与分项费用。
     * <p>复用 {@code lastPromptTokens}/{@code maxContextTokens} 让前端上下文面板
     * 直接展示 Agent 的真实窗口与已用量，而不是本地估算。</p>
     */
    UsageDTO readAcp(SessionStore.AcpUsage usage) {
        if (usage == null || usage.used() < 0 || usage.size() <= 0) {
            return new UsageDTO(0, 0, 0, 0, 0, 0, 0, null, false, 0, 0, 0, 0, null, null);
        }
        long used = usage.used();
        int size = usage.size() > Integer.MAX_VALUE ? Integer.MAX_VALUE : (int) usage.size();
        boolean priced = usage.cost() != null;
        return new UsageDTO(0, 0, 0, 0, used, size, 0, usage.model(), priced,
                0, 0, 0, priced ? usage.cost() : 0, priced ? usage.currency() : null, null);
    }

    private static CostBreakdown calculate(Map<String, Map<String, Double>> prices, ModelPriceProvider provider,
                                            String model, long[] usage) {
        return UsageCostCalculator.calculate(UsageCostCalculator.resolvePrice(prices, model, provider),
                usage[0], usage[1], usage[2]);
    }
}
