package site.sorghum.loopra.web.common;

import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;
import org.noear.solon.core.handle.ContextEmpty;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;

import static org.junit.jupiter.api.Assertions.*;

class GlobalExceptionFilterTest {

    @Test
    void businessErrorPreservesStatusAndPublicMessage() throws Exception {
        ContextEmpty context = new ContextEmpty();
        context.headerMap().put("Origin", "https://chatgpt.com");
        new GlobalExceptionFilter().doFilter(context, ignored -> {
            throw new ServiceException(409, "会话正在运行");
        });

        assertEquals(409, context.status());
        ONode body = body(context);
        assertFalse(body.get("success").getBoolean());
        assertEquals("会话正在运行", body.get("error").getString());
        assertEquals("https://chatgpt.com", context.headerOfResponse("Access-Control-Allow-Origin"));
    }

    @Test
    void unexpectedFailureReturns500WithoutLeakingDetails() throws Exception {
        ContextEmpty context = new ContextEmpty();
        new GlobalExceptionFilter().doFilter(context, ignored -> {
            throw new IllegalStateException("secret credential /private/config.json");
        });

        assertEquals(500, context.status());
        assertEquals(WebErrorMessages.INTERNAL_ERROR, body(context).get("error").getString());
        assertFalse(context.outputStream().toString().contains("secret credential"));
    }

    private static ONode body(ContextEmpty context) throws Exception {
        return ONode.ofJson(((ByteArrayOutputStream) context.outputStream()).toString(StandardCharsets.UTF_8));
    }
}
