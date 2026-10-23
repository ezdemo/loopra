package site.sorghum.loopra.web.model;

/**
 * 模型信息。
 */
public record ModelInfoDTO(
        String name,
        boolean active,
        String channelId,
        String channelName,
        String displayName
) {
}
