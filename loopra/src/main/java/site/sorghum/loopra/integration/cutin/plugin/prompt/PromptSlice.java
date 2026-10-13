package site.sorghum.loopra.integration.cutin.plugin.prompt;

/**
 * 系统提示词切片 —— prompt 插件化的最小单元。
 * <p>
 * 一个切片是一段 markdown 文本 + 排序键。所有切片在 {@code BEFORE_MODEL}
 * 拦截中按 order 升序拼接成最终 system prompt，热插拔时只需增删 slice。
 * </p>
 *
 * @param id      切片唯一标识，用于去重与调试
 * @param content markdown 内容，为空时该切片被忽略
 * @param order   越小越靠前。约定：0-99 身份、100-299 用户级提示词、300-499 技能规约、
 *                500 环境、600-899 工具约定、900 项目文档
 */
public record PromptSlice(String id, String content, int order) {

    public static PromptSlice of(String id, String content, int order) {
        return new PromptSlice(id, content, order);
    }

    public boolean isEmpty() {
        return content == null || content.isBlank();
    }
}
