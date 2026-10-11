package site.sorghum.loopra.web.common;

/**
 * Web 层错误消息常量 —— 避免在 Controller 中重复硬编码相同字符串。
 *
 * @author Sorghum
 */
public final class WebErrorMessages {

    private WebErrorMessages() {
        // 工具类，禁止实例化
    }

    /** Agent 未就绪时的通用错误消息 */
    public static final String AGENT_NOT_READY = "Agent 未初始化";

    /** 项目 hash 不能为空 */
    public static final String WORKSPACE_HASH_REQUIRED = "项目 hash 不能为空";

    /** message 不能为空 */
    public static final String MESSAGE_REQUIRED = "message 不能为空";

    /** 系统异常的公开消息；具体原因只写入服务端日志。 */
    public static final String INTERNAL_ERROR = "服务暂时无法完成请求，请稍后重试";

    public static String publicMessage(Exception exception) {
        return exception instanceof ServiceException ? exception.getMessage() : INTERNAL_ERROR;
    }

     /** slug 必填 */
    public static final String SLUG_REQUIRED = "slug is required";
}
