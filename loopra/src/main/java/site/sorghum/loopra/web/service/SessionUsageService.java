package site.sorghum.loopra.web.service;

import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.ONode;
import site.sorghum.loopra.bin.agent.context.ContextTokenEstimate;
import site.sorghum.loopra.bin.agent.context.ContextTokenEstimator;
import site.sorghum.loopra.bin.agent.core.LoopraAgent;
import site.sorghum.loopra.bin.config.ConfigService;
import site.sorghum.loopra.bin.model.ModelPriceProvider;
import site.sorghum.loopra.bin.session.SessionStore;
import site.sorghum.loopra.web.common.UsageCostCalculator;
import site.sorghum.loopra.web.common.UsageCostCalculator.CostBreakdown;
import site.sorghum.loopra.web.model.UsageDTO;

import java.util.Map;
import java.util.function.Supplier;
import java.util.function.ToIntFunction;

/** 将已选择 Agent 的用量与上下文估算转换为查询视图；不创建或切换 Agent。 */
@Slf4j
final class SessionUsageService {

    private final Supplier<Map<String, Map<String, Double>>> prices;
    private final Supplier<ModelPriceProvider> priceProvider;
    private final Supplier<String> defaultModel;
    private final ToIntFunction<String> contextSize;

    SessionUsageService() {
        this(() -> ConfigService.getConfig().price(), ModelMetaPriceProvider::getInstance,
                () -> ConfigService.getConfig().model());
    }

    SessionUsageService(Supplier<Map<String, Map<String, Double>>> prices,
                        Supplier<ModelPriceProvider> priceProvider, Supplier<String> defaultModel) {
        this(prices, priceProvider, defaultModel, SessionUsageService::configuredContextSize);
    }

    SessionUsageService(Supplier<Map<String, Map<String, Double>>> prices,
                        Supplier<ModelPriceProvider> priceProvider, Supplier<String> defaultModel,
                        ToIntFunction<String> contextSize) {
        this.prices = prices;
        this.priceProvider = priceProvider;
        this.defaultModel = defaultModel;
        this.contextSize = contextSize;
    }

    UsageDTO read(LoopraAgent agent) {
        if (agent == null) {
            return new UsageDTO(0, 0, 0, 0, 0, 128000, 0,
                    null, false, 0, 0, 0, 0, null, null, null, null);
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
                cost.hasPrice() ? "CNY" : null, estimate, "loopra", "request");
    }

    /**
     * 外部 Agent 的总占用以 ACP 上报为准，构成比例根据 Loopra 可见的会话估算。
     * 隐藏指令、工具定义以及 Agent 内部压缩后的历史不在可见范围内。
     */
    UsageDTO readAcp(SessionStore store, String name) {
        SessionStore.AcpUsage usage = store.getAcpUsage(name);
        String model = usage == null ? null : usage.model();
        if (model == null || model.isBlank()) {
            String saved = store.getAgentConfig(name).get("model");
            if (saved != null && !saved.isBlank()) {
                try { model = ONode.ofJson(saved).getString(); }
                catch (RuntimeException ignored) { model = saved; }
            }
        }
        ContextTokenEstimate estimate = null;
        try {
            estimate = ContextTokenEstimator.estimate(store.load(name), null, null);
        } catch (java.io.IOException | RuntimeException exception) {
            log.warn("[usage] 估算外部 Agent 会话构成失败: session={}", name, exception);
        }
        return readAcp(usage, estimate, model);
    }

    UsageDTO readAcp(SessionStore.AcpUsage usage) {
        return readAcp(usage, null, usage == null ? null : usage.model());
    }

    private UsageDTO readAcp(SessionStore.AcpUsage usage, ContextTokenEstimate estimate, String model) {
        boolean reported = usage != null && usage.used() >= 0 && usage.size() > 0;
        int size = usage != null && usage.size() > 0 ? (int) Math.min(Integer.MAX_VALUE, usage.size()) : 0;
        if (size <= 0 && model != null && !model.isBlank()) {
            try { size = Math.max(0, contextSize.applyAsInt(model)); }
            catch (RuntimeException exception) { log.warn("[usage] 读取外部 Agent 模型窗口失败: model={}", model, exception); }
        }
        boolean priced = usage != null && usage.cost() != null;
        return new UsageDTO(0, 0, 0, 0, reported ? usage.used() : 0, size, 0, model, priced,
                0, 0, 0, priced ? usage.cost() : 0, priced ? usage.currency() : null, estimate,
                reported ? "agent" : "loopra", "transcript");
    }

    private static int configuredContextSize(String model) {
        var config = ConfigService.getConfig();
        if (config == null) return 0;
        // External model ids have no Loopra channel binding. Conflicting windows
        // must remain unknown instead of silently using the Native model's window.
        var sizes = config.modelChannels().stream().map(channel -> channel.modelEntry(model))
                .filter(java.util.Objects::nonNull).map(entry -> entry.contextTokens())
                .filter(size -> size > 0).distinct().toList();
        return sizes.size() == 1 ? sizes.get(0) : 0;
    }

    private static CostBreakdown calculate(Map<String, Map<String, Double>> prices, ModelPriceProvider provider,
                                            String model, long[] usage) {
        return UsageCostCalculator.calculate(UsageCostCalculator.resolvePrice(prices, model, provider),
                usage[0], usage[1], usage[2]);
    }
}
