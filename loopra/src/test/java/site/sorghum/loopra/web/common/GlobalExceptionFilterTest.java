package site.sorghum.loopra.web.common;

import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;
import org.noear.solon.core.handle.ContextEmpty;

import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

class GlobalExceptionFilterTest {

    @Test
    void businessErrorPreservesStatusAndPublicMessage() throws Throwable {
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
    void unexpectedFailureReturns500WithoutLeakingDetails() throws Throwable {
        ContextEmpty context = new ContextEmpty();
        new GlobalExceptionFilter().doFilter(context, ignored -> {
            throw new IllegalStateException("secret credential /private/config.json");
        });

        assertEquals(500, context.status());
        assertEquals(WebErrorMessages.INTERNAL_ERROR, body(context).get("error").getString());
        assertFalse(context.outputStream().toString().contains("secret credential"));
    }

    @Test
    void occupiedSessionPreservesMachineReadableReason() throws Throwable {
        ContextEmpty context = new ContextEmpty();
        new GlobalExceptionFilter().doFilter(context, ignored -> {
            throw new ServiceException(409, "会话已被占用", "thread_active_writer");
        });
        assertEquals(409, context.status());
        assertEquals("thread_active_writer", body(context).get("reason").getString());
        assertEquals("会话已被占用", body(context).get("error").getString());
    }

    @Test
    void disconnectedResponseIsNotRetriedOrLoggedAsServerFailure() {
        AtomicInteger writes = new AtomicInteger();
        ContextEmpty context = disconnectedContext(writes);
        var logger = (ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger(GlobalExceptionFilter.class);
        var appender = new ch.qos.logback.core.read.ListAppender<ch.qos.logback.classic.spi.ILoggingEvent>();
        appender.start();
        logger.addAppender(appender);
        try {
            assertDoesNotThrow(() -> new GlobalExceptionFilter().doFilter(context, ctx -> ctx.output("response")));
            assertEquals(1, writes.get(), "Do not write a second error response into a disconnected socket");
            assertTrue(appender.list.stream().noneMatch(event ->
                    event.getLevel().isGreaterOrEqual(ch.qos.logback.classic.Level.WARN)));
        } finally {
            logger.detachAppender(appender);
            appender.stop();
        }
    }

    @Test
    void disconnectWhileWritingBusinessErrorDoesNotEscapeToContainer() {
        AtomicInteger writes = new AtomicInteger();
        ContextEmpty context = disconnectedContext(writes);
        assertDoesNotThrow(() -> new GlobalExceptionFilter().doFilter(context, ignored -> {
            throw new ServiceException(409, "会话已被占用");
        }));
        assertEquals(1, writes.get());
    }

    @Test
    void upstreamIoFailureStillReturnsServerError() throws Throwable {
        ContextEmpty context = new ContextEmpty();
        new GlobalExceptionFilter().doFilter(context, ignored -> {
            throw new IOException("upstream connection reset");
        });
        assertEquals(500, context.status());
        assertEquals(WebErrorMessages.INTERNAL_ERROR, body(context).get("error").getString());
    }

    private static ContextEmpty disconnectedContext(AtomicInteger writes) {
        return new ContextEmpty() {
            @Override public OutputStream outputStream() {
                return new OutputStream() {
                    @Override public void write(int value) throws IOException {
                        writes.incrementAndGet();
                        throw new org.eclipse.jetty.io.EofException("Closed");
                    }
                };
            }
        };
    }

    private static ONode body(ContextEmpty context) throws Exception {
        return ONode.ofJson(((ByteArrayOutputStream) context.outputStream()).toString(StandardCharsets.UTF_8));
    }
}
