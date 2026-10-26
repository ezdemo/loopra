package site.sorghum.loopra.bin.session;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.noear.snack4.ONode;
import site.sorghum.loopra.bin.agent.context.ConversationContext;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.prompt.PromptPrefix;

import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class SessionServiceTest {

    @TempDir
    Path tempDir;

    @Test
    void ignoresLeadingCollapsedBlockWhenGeneratingTitle() throws Exception {
        SessionService service = new SessionService(
                new ConversationContext(new PromptPrefix("test", ONode.ofJson("[]"))), tempDir);

        assertEquals("帮我分析这个项目", service.generateSessionTitle("""
                ```折叠块
                引用文件：
                - README.md
                
                调用技能：
                /skill:analysis
                ```
                
                帮我分析这个项目
                """));
    }

    @Test
    void usesDefaultTitleWhenMessageOnlyContainsCollapsedBlock() throws Exception {
        SessionService service = new SessionService(
                new ConversationContext(new PromptPrefix("test", ONode.ofJson("[]"))), tempDir);

        assertEquals("新会话", service.generateSessionTitle("""
                ```折叠块
                调用技能：
                /skill:analysis
                ```
                """));
    }

    @Test
    void generatedTitleUsesOnlyUserTextAndFallsBackOnFailure() throws Exception {
        SessionService service = new SessionService(
                new ConversationContext(new PromptPrefix("test", ONode.ofJson("[]"))), tempDir);
        service.setTitleGenerator(text -> {
            assertEquals("整理设置", text);
            return "模型用途设置";
        });
        assertEquals("模型用途设置", service.generateSessionTitle("```折叠块\n自动附带的文件\n```\n整理设置"));
        service.setTitleGenerator(text -> { throw new IllegalStateException("offline"); });
        assertEquals("整理设置", service.generateSessionTitle("整理设置"));
        service.setTitleGenerator(text -> " ");
        assertEquals("整理设置", service.generateSessionTitle("整理设置"));
    }

    @Test
    void usesInjectedSessionStore() throws Exception {
        JsonlSessionStore injected = new JsonlSessionStore(tempDir);
        ConversationContext ctx = new ConversationContext(new PromptPrefix("test", ONode.ofJson("[]")));

        SessionService service = new SessionService(ctx, injected);

        assertSame(injected, service.getStore());
        assertSame(injected, ctx.getSessionStore());
    }

    @Test
    void slowTitleGenerationDoesNotBlockTheFirstTurn() throws Exception {
        SessionService service = new SessionService(
                new ConversationContext(new PromptPrefix("test", ONode.ofJson("[]"))), tempDir);
        var started = new java.util.concurrent.CountDownLatch(1);
        var release = new java.util.concurrent.CountDownLatch(1);
        service.setTitleGenerator(text -> {
            started.countDown();
            try { release.await(3, java.util.concurrent.TimeUnit.SECONDS); }
            catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            return "生成的标题";
        });
        try {
            String name = assertTimeoutPreemptively(java.time.Duration.ofSeconds(1), () -> service.beforeTurn("原始消息"));
            assertTrue(started.await(1, java.util.concurrent.TimeUnit.SECONDS));
            assertEquals("原始消息", service.getStore().getTitle(name));
            release.countDown();
            assertTimeoutPreemptively(java.time.Duration.ofSeconds(3), () -> {
                while (!"生成的标题".equals(service.getStore().getTitle(name))) Thread.sleep(5);
            });
        } finally { release.countDown(); }
    }

    @Test
    void failedTitleGenerationKeepsTheFirstMessageTitleAndRunsOnlyOnce() throws Exception {
        SessionService service = new SessionService(
                new ConversationContext(new PromptPrefix("test", ONode.ofJson("[]"))), tempDir);
        var calls = new java.util.concurrent.atomic.AtomicInteger();
        service.setTitleGenerator(text -> {
            calls.incrementAndGet();
            throw new IllegalStateException("offline");
        });
        String name = service.beforeTurn("first message");
        service.beforeTurn("second message");
        assertTrue(java.util.concurrent.ForkJoinPool.commonPool().awaitQuiescence(3, java.util.concurrent.TimeUnit.SECONDS));
        assertEquals("first message", service.getStore().getTitle(name));
        assertEquals(1, calls.get());
    }

    @Test
    void pendingTitleGenerationDoesNotOverwriteManualRename() throws Exception {
        SessionService service = new SessionService(
                new ConversationContext(new PromptPrefix("test", ONode.ofJson("[]"))), tempDir);
        var started = new java.util.concurrent.CountDownLatch(1);
        var release = new java.util.concurrent.CountDownLatch(1);
        service.setTitleGenerator(text -> {
            started.countDown();
            try { release.await(3, java.util.concurrent.TimeUnit.SECONDS); }
            catch (InterruptedException error) { Thread.currentThread().interrupt(); }
            return "Generated title";
        });
        try {
            String name = service.beforeTurn("first message");
            assertTrue(started.await(1, java.util.concurrent.TimeUnit.SECONDS));
            service.getStore().updateTitle(name, "Manual title");
            release.countDown();
            assertTrue(java.util.concurrent.ForkJoinPool.commonPool().awaitQuiescence(3, java.util.concurrent.TimeUnit.SECONDS));
            assertEquals("Manual title", service.getStore().getTitle(name));
        } finally { release.countDown(); }
    }

    @Test
    void rawEventsSurviveContextCompaction() throws Exception {
        ConversationContext ctx = new ConversationContext(new PromptPrefix("test", ONode.ofJson("[]")));
        SessionService service = new SessionService(ctx, new JsonlSessionStore(tempDir));

        ctx.addUser("原始用户消息");
        ctx.addToolResult("call-1", "原始 tool result");
        ctx.compact(List.of(ChatMessage.ofUser("[历史上下文折叠]\n<compacted-summary>checkpoint</compacted-summary>")));

        List<ChatMessage> events = service.loadRawEvents();
        assertEquals(2, events.size());
        assertEquals("原始用户消息", events.get(0).getContent());
        assertEquals("call-1", events.get(1).getToolCallId());
        assertEquals("原始 tool result", events.get(1).getContent());

        List<ChatMessage> surface = service.getStore().load();
        assertEquals(1, surface.size());
        assertTrue(surface.get(0).getContent().contains("checkpoint"));
    }
}
