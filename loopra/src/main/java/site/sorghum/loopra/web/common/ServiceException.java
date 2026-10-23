package site.sorghum.loopra.web.common;

/**
 * 业务异常 —— 由 GlobalExceptionFilter 统一捕获并返回 ApiResponse.fail()。
 * <p>
 * 在 Controller 中遇到需要返回错误响应时，直接 throw 此异常，
 * 不再手动 return ApiResponse.fail()。
 * </p>
 *
 * @author Sorghum
 */
public class ServiceException extends RuntimeException {

    private final int code;
    private final String reason;

    public ServiceException(String message) {
        this(400, message);
    }

    public ServiceException(int code, String message) {
        this(code, message, null);
    }

    public ServiceException(int code, String message, String reason) {
        super(message);
        this.code = code;
        this.reason = reason;
    }

    /**
     * HTTP 状态码，默认 400
     */
    public int getCode() {
        return code;
    }

    public String getReason() {
        return reason;
    }
}
