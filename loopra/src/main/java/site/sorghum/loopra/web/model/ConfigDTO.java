package site.sorghum.loopra.web.model;

import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 配置信息（apiKey 脱敏）。
 */
public record ConfigDTO(
        String baseUrl,
        String model,
        List<String> availableModels,
        String workspace,
        String editMode,
        String reasoningEffort,
        String lang,
        String hitl,
        Set<String> disabledTools,
        List<String> blockedPaths,
        String apiKey,
        Map<String, Map<String, Double>> price,
        String activePet,
        boolean terminateOnNoToolCall,
        boolean fastMode,
        List<ModelChannelConfig> modelChannels,
        boolean modelChannelsConfigured,
        String modelChannelId,
        String validationModel,
        String validationModelChannelId,
        String imageUnderstandingModel,
        String imageUnderstandingModelChannelId
) {
    /** 不包含真实 API Key 的渠道配置。 */
    public record ModelChannelConfig(
            String id,
            String name,
            String baseUrl,
            String apiKey,
            String apiProtocol,
            String specialCompatibility,
            List<ModelConfig> models
    ) {
    }

    /** 渠道内单个模型的运行时能力和可选价格配置。 */
    public record ModelConfig(
            String name,
            int contextTokens,
            int maxTokens,
            boolean imageInput,
            Map<String, Double> price
    ) {
    }
}
