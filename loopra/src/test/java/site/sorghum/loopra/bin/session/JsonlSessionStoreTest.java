package site.sorghum.loopra.bin.session;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.model.FileChange;
import site.sorghum.loopra.bin.agent.model.ToolCallEntry;

import java.io.IOException;
import java.lang.reflect.Method;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;

import static org.junit.jupiter.api.Assertions.*;

class JsonlSessionStoreTest {

    private static int counter = 0;
    private JsonlSessionStore store;

    @BeforeEach
    void setUp() throws IOException {
        store = new JsonlSessionStore();
        // 使用唯一会话名避免测试间干扰
        counter++;
        store.bindTo("test-" + System.nanoTime() + "-" + counter);
    }

    @AfterEach
    void tearDown() {
        if (store != null) {
            store.shutdown();
        }
    }

    @Test
    void currentNameIsNullBeforeSwitch() throws IOException {
        // 新建 store 时 currentName 为 null（不自动分配会话名）
        JsonlSessionStore freshStore = new JsonlSessionStore();
        try {
            assertNull(freshStore.currentName());
            assertTrue(freshStore.loadEvents().isEmpty());
        } finally {
            freshStore.shutdown();
        }
    }

    @Test
    void currentNameIsNonNullAfterSwitch() {
        // setUp 中已 switchTo，此时 currentName 非空
        assertNotNull(store.currentName());
        assertFalse(store.currentName().isEmpty());
    }

    @Test
    void appendAndLoad() throws IOException {
        ChatMessage msg = ChatMessage.ofUser("hello");
        store.append(msg);

        store.flush();
        List<ChatMessage> loaded = store.load();
        assertEquals(1, loaded.size());
        assertEquals("user", loaded.get(0).getRole());
        assertEquals("hello", loaded.get(0).getContent());
    }

    @Test
    void toolExecutionTimingRoundTripsThroughJsonl() throws IOException {
        ChatMessage msg = ChatMessage.tool("tc-timing", "result", 1_000L, 1_125L);
        store.append(msg);
        store.flush();

        ChatMessage loaded = store.load().get(0);
        assertEquals(1_000L, loaded.getToolStartedAt());
        assertEquals(1_125L, loaded.getToolFinishedAt());
        assertEquals(125L, loaded.getToolDurationMs());
    }

    @Test
    void loadFromAnotherStoreWaitsForOngoingWrite() throws Exception {
        store.append(ChatMessage.ofUser("complete message"));
        store.flush();

        Path sessionsDir = Paths.get(System.getProperty("user.home"), ".loopra", "sessions");
        Path sessionFile = sessionsDir.resolve(store.currentName() + ".jsonl");
        Method fileLockMethod = JsonlSessionStore.class.getDeclaredMethod("fileLock", Path.class);
        fileLockMethod.setAccessible(true);
        ReentrantLock writeLock = (ReentrantLock) fileLockMethod.invoke(null, sessionFile);
        JsonlSessionStore readerStore = new JsonlSessionStore(sessionsDir);
        ExecutorService reader = Executors.newSingleThreadExecutor();
        writeLock.lock();
        try {
            Future<List<ChatMessage>> loading = reader.submit(() -> readerStore.load(store.currentName()));
            Thread.sleep(50);
            assertFalse(loading.isDone(), "load must not read while another Store writes the same session");

            writeLock.unlock();
            assertEquals(1, loading.get(1, TimeUnit.SECONDS).size());
        } finally {
            if (writeLock.isHeldByCurrentThread()) writeLock.unlock();
            reader.shutdownNow();
            readerStore.shutdown();
        }
    }

    @Test
    void appendMultipleMessages() throws IOException {
        for (int i = 0; i < 5; i++) {
            ChatMessage msg = ChatMessage.ofUser("msg" + i);
            store.append(msg);
        }
        store.flush();
        List<ChatMessage> loaded = store.load();
        assertEquals(5, loaded.size());
    }

    @Test
    void rewriteReplacesAllMessages() throws IOException {
        ChatMessage msg1 = ChatMessage.ofUser("original");
        store.append(msg1);
        store.flush();

        List<ChatMessage> newMsgs = new ArrayList<>();
        newMsgs.add(ChatMessage.assistant("replaced", null, null));
        store.rewrite(newMsgs);

        List<ChatMessage> loaded = store.load();
        assertEquals(1, loaded.size());
        assertEquals("replaced", loaded.get(0).getContent());
    }

    @Test
    void bindToAndLoad() throws IOException {
        String uniqueName = "sw-" + System.nanoTime();
        ChatMessage msg = ChatMessage.ofUser("in session 1");
        store.append(msg);
        store.flush();

        String name1 = store.currentName();
        assertTrue(store.bindTo(uniqueName));
        assertNotEquals(name1, store.currentName());

        ChatMessage msg2 = ChatMessage.ofUser("in session 2");
        store.append(msg2);
        store.flush();

        List<ChatMessage> loaded = store.load();
        assertEquals(1, loaded.size());
        assertEquals("in session 2", loaded.get(0).getContent());

        store.bindTo(name1);
        List<ChatMessage> loaded1 = store.load();
        assertEquals(1, loaded1.size());
        assertEquals("in session 1", loaded1.get(0).getContent());
    }

    @Test
    void bindToPreservesReplicaName() throws IOException {
        String name = "原会话[复刻]";
        assertTrue(store.bindTo(name));
        assertEquals(name, store.currentName());

        store.append(ChatMessage.ofUser("copied"));
        store.flush();

        assertTrue(store.list().stream().anyMatch(session -> name.equals(session.name())));
    }

    @Test
    void listReturnsSessions() throws IOException {
        ChatMessage msg = ChatMessage.ofUser("hi");
        store.append(msg);
        store.flush();

        List<SessionStore.SessionInfo> sessions = store.list();
        assertFalse(sessions.isEmpty());
        boolean found = false;
        for (SessionStore.SessionInfo s : sessions) {
            if (s.name().equals(store.currentName())) {
                found = true;
                assertTrue(s.messageCount() >= 1);
            }
        }
        assertTrue(found, "当前会话应在列表中");
    }

    @Test
    void planMetadataOnlySessionIsListedAndDeletable() throws IOException {
        String name = "plan-only-" + System.nanoTime();
        store.bindTo(name);
        store.setPlanMode(name, true);

        SessionStore.SessionInfo info = store.list().stream()
                .filter(session -> name.equals(session.name()))
                .findFirst()
                .orElseThrow();
        assertEquals(0, info.messageCount());
        assertTrue(store.delete(name));
        assertTrue(store.list().stream().noneMatch(session -> name.equals(session.name())));
    }

    @Test
    void titleAndPlanModeMetadataDoNotOverwriteEachOther() throws IOException {
        String name = store.currentName();

        store.updateTitle(name, "Initial title");
        store.setPlanMode(name, true);
        store.setPendingPlan(name, "1. inspect\n2. implement");

        assertEquals("Initial title", store.getTitle(name));
        assertTrue(store.isPlanMode(name));
        assertEquals("1. inspect\n2. implement", store.getPendingPlan(name));

        store.updateTitle(name, "Updated title");
        assertTrue(store.isPlanMode(name));

        store.setPlanMode(name, false);
        assertEquals("Updated title", store.getTitle(name));
        assertFalse(store.isPlanMode(name));
        assertEquals("1. inspect\n2. implement", store.getPendingPlan(name));

        store.setPendingPlan(name, null);
        assertNull(store.getPendingPlan(name));
    }

    @Test
    void worktreeModeAndMergeModePersistIndependently() throws IOException {
        String name = store.currentName();

        assertFalse(store.isWorktreeMode(name));
        assertEquals("manual", store.getMergeMode(name));

        store.setWorktreeMode(name, true);
        store.setMergeMode(name, "ai-auto");
        assertTrue(store.isWorktreeMode(name));
        assertEquals("ai-auto", store.getMergeMode(name));

        // 与其他元数据字段共存（title / planMode）
        store.updateTitle(name, "隔离会话");
        store.setPlanMode(name, true);
        assertEquals("隔离会话", store.getTitle(name));
        assertTrue(store.isPlanMode(name));
        assertTrue(store.isWorktreeMode(name));
        assertEquals("ai-auto", store.getMergeMode(name));

        // 隔离分支开关出现在 list() 的 SessionInfo 中
        SessionStore.SessionInfo info = store.list().stream()
                .filter(session -> name.equals(session.name()))
                .findFirst()
                .orElseThrow();
        assertTrue(info.worktreeMode());

        store.setWorktreeMode(name, false);
        assertFalse(store.isWorktreeMode(name));
        assertEquals("ai-auto", store.getMergeMode(name));

        // mergeMode 置空回退 manual
        store.setMergeMode(name, null);
        assertEquals("manual", store.getMergeMode(name));
    }

    @Test
    void modelSettingsPersistWithoutOverwritingOtherMetadata() throws IOException {
        String name = store.currentName();

        store.updateTitle(name, "固定模型会话");
        store.setPlanMode(name, true);
        store.setModelSettings(name, "gpt-session", "channel-session", "high");

        SessionStore.SessionModelSettings settings = store.getModelSettings(name);
        assertEquals("gpt-session", settings.model());
        assertEquals("channel-session", settings.modelChannelId());
        assertEquals("high", settings.reasoningEffort());
        assertEquals("固定模型会话", store.getTitle(name));
        assertTrue(store.isPlanMode(name));

        store.setModelSettings(name, "gpt-next", "channel-next", "low");
        settings = store.getModelSettings(name);
        assertEquals("gpt-next", settings.model());
        assertEquals("channel-next", settings.modelChannelId());
        assertEquals("low", settings.reasoningEffort());
        assertEquals("固定模型会话", store.getTitle(name));
        assertTrue(store.isPlanMode(name));
    }

    @Test
    void concurrentMetadataUpdatesPreserveAllFields() throws Exception {
        Path sessionsDir = java.nio.file.Files.createTempDirectory("loopra-meta-lock");
        JsonlSessionStore first = new JsonlSessionStore(sessionsDir);
        JsonlSessionStore second = new JsonlSessionStore(sessionsDir);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            String name = "concurrent-meta";
            first.bindTo(name);
            second.bindTo(name);
            for (int i = 0; i < 50; i++) {
                final int round = i;
                Future<?> titleWrite = executor.submit(() -> {
                    try {
                        first.updateTitle(name, "title-" + round);
                    } catch (IOException e) {
                        throw new RuntimeException(e);
                    }
                });
                Future<?> modeWrite = executor.submit(() -> second.setPlanMode(name, true));
                titleWrite.get(2, TimeUnit.SECONDS);
                modeWrite.get(2, TimeUnit.SECONDS);
                assertEquals("title-" + round, first.getTitle(name));
                assertTrue(second.isPlanMode(name));
            }
        } finally {
            executor.shutdownNow();
            first.shutdown();
            second.shutdown();
        }
    }

    @Test
    void saveAndLoadUsage() throws IOException {
        store.saveUsage("test-session", 100, 200, 50, 50);
        long[] usage = store.loadUsage("test-session");
        assertEquals(100, usage[0]);
        assertEquals(200, usage[1]);
        assertEquals(50, usage[2]);
        assertEquals(50, usage[3]);
        assertEquals(0, usage[4]); // 上次输入 token 数
    }

    @Test
    void loadUsageNonexistentReturnsZeros() {
        long[] usage = store.loadUsage("nonexistent-session-12345");
        assertEquals(0, usage[0]);
        assertEquals(0, usage[1]);
        assertEquals(0, usage[2]);
        assertEquals(0, usage[3]);
        assertEquals(0, usage[4]);
    }

    @Test
    void deleteSession() throws IOException {
        ChatMessage msg = ChatMessage.ofUser("to be deleted");
        store.append(msg);
        store.flush();

        String name = store.currentName();
        boolean deleted = store.delete(name);
        assertTrue(deleted);
    }

    @Test
    void newSessionNameHasCorrectFormat() {
        String name = store.newSessionName();
        assertTrue(name.startsWith("loopra-"), "会话名应以 loopra- 开头");
        assertTrue(name.length() > "loopra-".length(), "会话名应包含时间戳");
    }

    @Test
    void serializeMessageWithToolCalls() {
        ChatMessage msg = ChatMessage.assistant("I'll edit",
                List.of(new ToolCallEntry("tc_1", "edit_file", "{\"path\":\"a.java\"}")),
                null);

        String json = JsonlSessionStore.serializeMessage(msg);
        assertTrue(json.contains("edit_file"));
        assertTrue(json.contains("tc_1"));
    }

    @Test
    void imageToolResultSurvivesSessionRoundTrip() throws IOException {
        ChatMessage message = ChatMessage.toolWithImage("call-image", "图片已读取",
                "data:image/png;base64,AA==", "low");
        store.append(message);
        store.flush();

        ChatMessage loaded = store.load().get(0);

        assertEquals("call-image", loaded.getToolCallId());
        assertEquals("data:image/png;base64,AA==", loaded.getToolImageUrl());
        assertEquals("low", loaded.getToolImageDetail());
    }

    @Test
    void responsesReasoningSurvivesSessionRoundTrip() throws IOException {
        String responseReasoning = "{\"type\":\"reasoning\",\"encrypted_content\":\"encrypted\"}";
        ChatMessage message = ChatMessage.assistant("", List.of(new ToolCallEntry(
                "call_1", "read", "{}", responseReasoning)), null);
        store.append(message);
        store.flush();

        ChatMessage loaded = store.load().get(0);

        assertEquals("call_1", loaded.getToolCalls().get(0).id());
        assertEquals(responseReasoning, loaded.getResponseReasoning());
        assertNull(loaded.getToolCalls().get(0).responseReasoning());
    }

    @Test
    void fileChangesSurviveSessionRoundTrip() throws IOException {
        ChatMessage message = ChatMessage.assistant("已完成", null, null);
        message.setFileChanges(List.of(new FileChange("src/App.java", 12, 3, false, "@@ -1 +1 @@\n-old\n+new\n")));
        store.append(message);
        store.flush();

        ChatMessage loaded = store.load().get(0);

        assertNotNull(loaded.getFileChanges());
        assertEquals(1, loaded.getFileChanges().size());
        assertEquals("src/App.java", loaded.getFileChanges().get(0).path());
        assertEquals(12, loaded.getFileChanges().get(0).additions());
        assertEquals(3, loaded.getFileChanges().get(0).deletions());
        assertTrue(loaded.getFileChanges().get(0).diff().contains("+new"));
    }

    @Test
    void turnTimingSurvivesSessionRoundTrip() throws IOException {
        ChatMessage message = ChatMessage.assistant("已完成", null, null);
        message.setTurnStartedAt(1_000L);
        message.setTurnFinishedAt(6_000L);
        message.setElapsedMs(5_000L);
        store.append(message);
        store.flush();

        ChatMessage loaded = store.load().get(0);

        assertEquals(1_000L, loaded.getTurnStartedAt());
        assertEquals(6_000L, loaded.getTurnFinishedAt());
        assertEquals(5_000L, loaded.getElapsedMs());
    }

    @Test
    void flushDoesNotThrow() {
        assertDoesNotThrow(() -> store.flush());
    }

    @Test
    void rewriteKeepsRawEventsAppendOnly() throws IOException {
        store.append(ChatMessage.ofUser("original user message"));
        store.append(ChatMessage.tool("call-1", "large original tool result"));
        store.flush();

        List<ChatMessage> folded = new ArrayList<>();
        folded.add(ChatMessage.ofUser("[历史上下文折叠]\n<compacted-summary>checkpoint</compacted-summary>"));
        store.rewrite(folded);

        List<ChatMessage> surface = store.load();
        assertEquals(1, surface.size());
        assertTrue(surface.get(0).getContent().contains("<compacted-summary>"));

        List<ChatMessage> events = store.loadEvents();
        assertEquals(2, events.size());
        assertEquals("original user message", events.get(0).getContent());
        assertEquals("call-1", events.get(1).getToolCallId());
        assertEquals("large original tool result", events.get(1).getContent());
    }

    @Test
    void eventsContinueAfterRewriteAndAreReadableFromAnotherStore() throws IOException {
        Path tempDir = java.nio.file.Files.createTempDirectory("loopra-events");
        JsonlSessionStore writer = new JsonlSessionStore(tempDir);
        try {
            String name = "event-session";
            writer.bindTo(name);
            writer.append(ChatMessage.ofUser("original"));
            writer.append(ChatMessage.tool("call-1", "raw result"));
            writer.rewrite(List.of(ChatMessage.ofUser("[历史上下文折叠] checkpoint")));
            writer.append(ChatMessage.ofUser("after rewrite"));
            writer.flush();

            JsonlSessionStore reader = new JsonlSessionStore(tempDir);
            try {
                List<ChatMessage> events = reader.loadEvents(name);
                assertEquals(3, events.size());
                assertEquals("original", events.get(0).getContent());
                assertEquals("raw result", events.get(1).getContent());
                assertEquals("after rewrite", events.get(2).getContent());

                List<ChatMessage> surface = reader.load(name);
                assertEquals(2, surface.size());
                assertTrue(surface.get(0).getContent().contains("checkpoint"));
                assertEquals("after rewrite", surface.get(1).getContent());
            } finally {
                reader.shutdown();
            }
        } finally {
            writer.shutdown();
        }
    }

    @Test
    void loadEventsNonexistentReturnsEmpty() throws IOException {
        Path tempDir = java.nio.file.Files.createTempDirectory("loopra-events-missing");
        JsonlSessionStore isolated = new JsonlSessionStore(tempDir);
        try {
            isolated.bindTo("no-events");
            assertTrue(isolated.loadEvents().isEmpty());
        } finally {
            isolated.shutdown();
        }
    }

    @Test
    void deleteRemovesEventsFile() throws IOException {
        Path tempDir = java.nio.file.Files.createTempDirectory("loopra-events-delete");
        JsonlSessionStore isolated = new JsonlSessionStore(tempDir);
        try {
            String name = "delete-events";
            isolated.bindTo(name);
            isolated.append(ChatMessage.ofUser("original"));
            isolated.flush();

            assertFalse(isolated.loadEvents().isEmpty());
            assertTrue(isolated.delete(name));
            assertTrue(isolated.loadEvents().isEmpty());
            assertFalse(java.nio.file.Files.exists(tempDir.resolve(name + ".events")));
        } finally {
            isolated.shutdown();
        }
    }
}
