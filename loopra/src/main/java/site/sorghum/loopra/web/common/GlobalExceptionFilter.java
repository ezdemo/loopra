package site.sorghum.loopra.web.common;

import lombok.extern.slf4j.Slf4j;
import org.noear.solon.annotation.Component;
import org.noear.solon.core.handle.Context;
import org.noear.solon.core.handle.Filter;
import org.noear.solon.core.handle.FilterChain;
import site.sorghum.loopra.web.model.ApiResponse;

/**
 * 全局异常拦截 Filter —— 所有未捕获异常统一返回 ApiResponse JSON 格式。
 * <p>
 * {@code index = 0} 确保最先执行，兜住所有下游抛出的异常。
 * </p>
 *
 * <pre>{@code
 * // Controller 中不再需要 try-catch，直接：
 * if (xxx) throw new ServiceException("message 不能为空");
 * // 或让业务异常自然向上传播
 * }</pre>
 *
 * @author Sorghum
 */
@Component(index = 0)
@Slf4j
public class GlobalExceptionFilter implements Filter {

    @Override
    public void doFilter(Context ctx, FilterChain chain) {
        // 异常响应也必须保留 MCP 浏览器客户端需要的 CORS 头。
        // 不能使用 "*" 配合 credentials；这里按请求 Origin 精确返回，且不启用凭证。
        applyCorsHeaders(ctx);

        // OPTIONS 预检请求直接放行
        if ("OPTIONS".equals(ctx.method())) {
            ctx.output("");
            return;
        }

        try {
            chain.doFilter(ctx);
        } catch (ServiceException e) {
            ctx.status(e.getCode());
            ctx.outputAsJson(ApiResponse.fail(e.getMessage()).toString());
        } catch (Throwable e) {
            // 未预期的系统异常 → 500（避免泄露内部细节）
            log.error("GlobalExceptionFilter error", e);
            ctx.status(500);
            ctx.outputAsJson(ApiResponse.fail(WebErrorMessages.INTERNAL_ERROR).toString());
        }
    }

    private static void applyCorsHeaders(Context ctx) {
        String origin = ctx.header("Origin");
        if (origin == null || origin.isBlank()) {
            return;
        }

        ctx.headerSet("Access-Control-Allow-Origin", origin);
        ctx.headerSet("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
        String requestedHeaders = ctx.header("Access-Control-Request-Headers");
        ctx.headerSet("Access-Control-Allow-Headers",
                requestedHeaders == null || requestedHeaders.isBlank() ? "*" : requestedHeaders);
        ctx.headerSet("Access-Control-Expose-Headers", "Mcp-Session-Id");
        ctx.headerSet("Access-Control-Max-Age", "3600");
        ctx.headerSet("Vary", "Origin");
    }
}
