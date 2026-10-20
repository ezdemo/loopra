package site.sorghum.loopra.web.model;

import site.sorghum.loopra.bin.agent.context.ContextTokenEstimate;

/**
 * Token 用量统计。
 */
public record UsageDTO(
        long promptTokens,
        long completionTokens,
        long cacheHit,
        long cacheMiss,
        long lastPromptTokens,
        int maxContextTokens,
        long totalTokens,
        String model,
        boolean hasPrice,
        double inputCost,
        double cacheCost,
        double outputCost,
        double totalCost,
        String currency,
        ContextTokenEstimate contextEstimate,
        String contextSource,
        String contextEstimateScope
) {
}
