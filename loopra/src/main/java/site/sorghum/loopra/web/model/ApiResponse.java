package site.sorghum.loopra.web.model;

import lombok.Data;
import org.noear.snack4.ONode;

/**
 * 统一 API 响应封装。
 *
 * @author Sorghum
 */
@Data
public class ApiResponse<T> {

    private boolean success;
    private String error;
    private String reason;
    private T data;

    public static <T> ApiResponse<T> ok(T data) {
        ApiResponse<T> r = new ApiResponse<>();
        r.success = true;
        r.data = data;
        return r;
    }

    public static <T> ApiResponse<T> fail(String error) {
        return fail(error, null);
    }

    public static <T> ApiResponse<T> fail(String error, String reason) {
        ApiResponse<T> r = new ApiResponse<>();
        r.success = false;
        r.error = error;
        r.reason = reason;
        return r;
    }

    @Override
    public String toString() {
        return ONode.ofBean(this).toString();
    }
}
