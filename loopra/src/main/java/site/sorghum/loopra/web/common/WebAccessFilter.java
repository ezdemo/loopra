package site.sorghum.loopra.web.common;

import org.noear.solon.core.handle.Context;
import org.noear.solon.core.handle.Filter;
import org.noear.solon.core.handle.FilterChain;
import org.noear.solon.SolonApp;
import org.noear.solon.web.cors.CrossFilter;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;

/** Process-scoped access key. Never expose it through an unauthenticated API. */
public final class WebAccessFilter implements Filter {
    public static final String HEADER = "X-Loopra-Key";
    private final byte[] key;

    public WebAccessFilter(String key) {
        if (key == null || key.isBlank()) throw new IllegalArgumentException("Access key is required");
        this.key = key.getBytes(StandardCharsets.UTF_8);
    }

    public static String createKey() {
        // The desktop launcher supplies a fresh key to its child via environment,
        // so even its first readiness probe can authenticate without parsing logs.
        String desktopKey = System.getenv("LOOPRA_ACCESS_KEY");
        if (desktopKey != null && desktopKey.matches("[A-Za-z0-9_-]{43,128}")) return desktopKey;
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    public static void install(SolonApp app, String key) {
        // CORS preflight contains no credentials or application data. It must
        // finish before authentication; actual requests still require the key.
        app.router().filter(-100, new CrossFilter()
                .allowedOrigins("*").allowCredentials(false)
                .allowedHeaders("Content-Type,X-Loopra-Key,X-Request-ID,X-Timestamp,Authorization,Mcp-Session-Id,Mcp-Protocol-Version,Last-Event-ID")
                .exposedHeaders("Mcp-Session-Id"));
        app.router().filter(-90, new WebAccessFilter(key));
    }

    @Override
    public void doFilter(Context ctx, FilterChain chain) throws Throwable {
        ctx.headerSet("Referrer-Policy", "no-referrer");
        String path = ctx.path();
        boolean read = "GET".equals(ctx.method()) || "HEAD".equals(ctx.method());
        // Only files actually bundled with the application are public. An API
        // with a .js/.png suffix must not accidentally bypass authentication.
        boolean api = path.equals("/api") || path.startsWith("/api/");
        boolean bundled = !api && !path.contains("..") && !path.contains("\\")
                && (path.equals("/") || path.equals("/config.json")
                || WebAccessFilter.class.getResource("/static" + path) != null);
        if (read && bundled) {
            chain.doFilter(ctx);
            return;
        }
        ctx.headerSet("Cache-Control", "no-store");
        String supplied = ctx.header(HEADER);
        // CSS/image elements cannot set headers. Limit URL credentials to this
        // read-only image endpoint; ordinary API requests must use the header.
        if (supplied == null && read && path.matches("/api/pets/[^/]+/spritesheet")) {
            supplied = ctx.param("rk");
        }
        if (supplied != null && MessageDigest.isEqual(key, supplied.getBytes(StandardCharsets.UTF_8))) {
            chain.doFilter(ctx);
            return;
        }
        ctx.status(401);
        ctx.outputAsJson("{\"success\":false,\"reason\":\"access_key_required\",\"error\":\"访问密钥缺失或错误，请输入启动日志中的 rk 密钥\"}");
        ctx.setHandled(true);
    }
}
