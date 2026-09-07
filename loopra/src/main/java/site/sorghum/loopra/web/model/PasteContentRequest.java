package site.sorghum.loopra.web.model;

import lombok.Data;

/** 保存输入框中超大文本的请求。 */
@Data
public class PasteContentRequest {

    /** 项目 hash。 */
    private String workspaceHash;

    /** 要保存的纯文本内容。 */
    private String content;
}
