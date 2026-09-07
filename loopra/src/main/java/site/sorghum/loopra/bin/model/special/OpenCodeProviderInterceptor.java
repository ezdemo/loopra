package site.sorghum.loopra.bin.model.special;

import org.noear.snack4.ONode;
import org.noear.solon.annotation.Component;
import site.sorghum.cutin.integrations.model.ProviderInterceptContext;
import site.sorghum.cutin.integrations.model.ProviderInterceptor;

import java.util.Map;

/** OpenCode Zen/Go 网关兼容插件。 */
@Component
public class OpenCodeProviderInterceptor implements ProviderInterceptor {

    public OpenCodeProviderInterceptor() {
        ProviderInterceptor.register(this);
    }

    @Override
    public ONode intercept(ProviderInterceptContext context) {
        return null;
    }

    @Override
    public void interceptHeaders(ProviderInterceptContext context) {
        if (!"opencode".equals(option(context.options(), "specialCompatibility"))) {
            return;
        }
        String sessionId = option(context.options(), "sessionAffinity");
        if (sessionId == null || sessionId.isBlank()) {
            sessionId = option(context.options(), "fallbackSessionId");
        }
        if (sessionId != null && !sessionId.isBlank()) {
            context.headers().put("x-opencode-session", sessionId);
        }
    }

    private static String option(Map<String, Object> options, String key) {
        Object value = options == null ? null : options.get(key);
        return value == null ? null : String.valueOf(value);
    }
}
