package site.sorghum.loopra.web.model;

import lombok.Data;

/** 请求 Java 服务直接执行核心版本更新。 */
@Data
public class VersionUpdateRequest {

    /** normal、mirror 或受支持镜像的 HTTPS 地址。 */
    private String source;
}
