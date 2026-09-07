package site.sorghum.loopra.web.model;

/** 已保存的超大粘贴文本信息。 */
public record PasteContentDTO(
        String name,
        String path,
        int chars,
        long bytes
) {
}
