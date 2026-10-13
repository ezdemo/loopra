package site.sorghum.loopra.web.model;

/**
 * 系统提示词 DTO。
 */
public record PromptDTO(
        /** 系统提示词原文（含工具定义、Skill 索引等拼接后的完整内容） */
        String content,
        /** 字符数 */
        int length
) {
}
