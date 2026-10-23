package site.sorghum.loopra.bin.agent.model;

import java.util.Locale;

/**
 * 图片工具结果协议 —— read_image 等视觉工具的结果编解码。
 * <p>
 * 工具以 {@link #RESULT_PREFIX} 前缀的文本协议返回图片结果，
 * AgentLoop 据此把图片作为多模态消息回放给模型。
 * </p>
 *
 * @author Sorghum
 */
public final class ImageToolResult {

    /** 图片结果协议前缀（工具原始输出 → AgentLoop 解析） */
    public static final String RESULT_PREFIX = "__LOOPRA_IMAGE_RESULT__\n";

    private ImageToolResult() {
    }

    /**
     * 解析后的图片结果。
     *
     * @param summary 面向用户的文字摘要
     * @param dataUri 图片 data URI（data:image/...;base64,...）
     * @param detail  图片分析精度（auto / low / high）
     */
    public record ImageResult(String summary, String dataUri, String detail) {
    }

    /**
     * 规范化 detail 参数；非法值返回 {@code null}。
     */
    public static String normalizeDetail(String detail) {
        String value = detail == null || detail.isBlank() ? "auto" : detail.trim().toLowerCase(Locale.ROOT);
        return "auto".equals(value) || "low".equals(value) || "high".equals(value) ? value : null;
    }

    /**
     * 构造图片结果协议文本。
     */
    public static String imageResult(String summary, String dataUri, String detail) {
        if (dataUri == null || !dataUri.startsWith("data:image/")) {
            throw new IllegalArgumentException("image data URI is invalid");
        }
        String normalizedDetail = normalizeDetail(detail);
        if (normalizedDetail == null) {
            throw new IllegalArgumentException("image detail is invalid");
        }
        String text = summary == null || summary.isBlank() ? "图片已读取。" : summary.replaceAll("\\R", " ");
        return RESULT_PREFIX + normalizedDetail + "\n" + text + "\n" + dataUri;
    }

    /**
     * 解析图片结果协议文本；非图片结果返回 {@code null}。
     */
    public static ImageResult parseResult(String result) {
        if (result == null || !result.startsWith(RESULT_PREFIX)) return null;
        String[] fields = result.substring(RESULT_PREFIX.length()).split("\\n", 3);
        if (fields.length != 3 || !fields[2].startsWith("data:image/")) return null;
        return new ImageResult(fields[1], fields[2], fields[0]);
    }
}
