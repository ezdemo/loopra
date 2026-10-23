package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Test;
import org.noear.solon.core.handle.ContextEmpty;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.*;

class SseEmitterTest {

    @Test
    void occupiedSessionReasonSurvivesTheErrorStream() throws Exception {
        ContextEmpty context = new ContextEmpty();
        SseEmitter emitter = new SseEmitter(context);
        emitter.sendError("会话已被占用", "thread_active_writer");

        String stream = body(context);
        assertTrue(stream.contains("\"reason\":\"thread_active_writer\""));
        assertTrue(stream.contains("\"error\":\"会话已被占用\""));
        assertTrue(stream.endsWith("event: done\ndata: {}\n\n"));
        assertTrue(emitter.isCompleted());
    }

    @Test
    void completionWritesOneDoneEventAndRejectsLateMessages() throws Exception {
        ContextEmpty context = new ContextEmpty();
        SseEmitter emitter = new SseEmitter(context);
        emitter.sendComplete("answer");
        emitter.complete();
        emitter.complete();
        emitter.sendContent("late");

        assertEquals("event: complete\ndata: \"answer\"\n\nevent: done\ndata: {}\n\n", body(context));
        assertTrue(emitter.isCompleted());
        assertTimeoutPreemptively(Duration.ofSeconds(1), () -> { emitter.awaitCompletion(); });
    }

    @Test
    void concurrentCompletionsCannotDuplicateTheTerminalEvent() throws Exception {
        ContextEmpty context = new ContextEmpty();
        SseEmitter emitter = new SseEmitter(context);
        var executor = Executors.newFixedThreadPool(2);
        CountDownLatch start = new CountDownLatch(1);
        try {
            var futures = new ArrayList<Future<?>>();
            for (int index = 0; index < 8; index++) {
                futures.add(executor.submit(() -> {
                    start.await();
                    emitter.complete();
                    return null;
                }));
            }
            start.countDown();
            for (var future : futures) future.get(5, TimeUnit.SECONDS);
            assertEquals("event: done\ndata: {}\n\n", body(context));
        } finally {
            start.countDown();
            executor.shutdownNow();
            assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS));
        }
    }

    @Test
    void disconnectedStreamStillCompletesAndClosesItsOutput() throws Exception {
        AtomicBoolean closed = new AtomicBoolean();
        OutputStream disconnected = new OutputStream() {
            @Override public void write(int value) throws IOException { throw new IOException("disconnected"); }
            @Override public void close() { closed.set(true); }
        };
        SseEmitter emitter = new SseEmitter(new ContextEmpty() {
            @Override public OutputStream outputStream() { return disconnected; }
        });
        assertDoesNotThrow(emitter::complete);
        assertTrue(emitter.isCompleted());
        assertTrue(closed.get());
        assertTimeoutPreemptively(Duration.ofSeconds(1), () -> { emitter.awaitCompletion(); });
    }

    private static String body(ContextEmpty context) throws Exception {
        return ((ByteArrayOutputStream) context.outputStream()).toString(StandardCharsets.UTF_8);
    }
}
