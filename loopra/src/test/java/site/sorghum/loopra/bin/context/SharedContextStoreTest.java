package site.sorghum.loopra.bin.context;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Optional;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

/**
 * {@link SharedContextStore} 的单元测试。
 *
 * @author Sorghum
 */
class SharedContextStoreTest {

    private SharedContextStore workspace;

    @TempDir
    Path tempDir;

    @BeforeEach
    void setUp() {
        workspace = new SharedContextStore(100);
    }

    // ==================== 写入并读取 KV ====================

    @Test
    void testWriteAndReadKV() {
        workspace.writeKV("greeting", "hello", "tester");
        Optional<String> result = workspace.readKV("greeting");
        assertTrue(result.isPresent(), "写入后应能读取到值");
        assertEquals("hello", result.get(), "读取的值应与写入的值一致");
    }

    // ==================== 写入并读取文档 ====================

    @Test
    void testWriteAndReadDoc() {
        workspace.writeDoc("readme", "# Hello World", "text/markdown", "tester");
        Optional<DocumentBucket> result = workspace.readDoc("readme");
        assertTrue(result.isPresent(), "写入后应能读取到文档");
        DocumentBucket doc = result.get();
        assertEquals("# Hello World", doc.getContent(), "文档内容应一致");
        assertEquals("text/markdown", doc.getMimeType(), "MIME 类型应一致");
    }

    // ==================== 更新 KV ====================

    @Test
    void testUpdateKV() {
        workspace.writeKV("counter", "1", "tester");

        // 第一次读取，版本应为 1
        Optional<KVBucket> bucket1 = workspace.getKVBucket("counter");
        assertTrue(bucket1.isPresent());
        assertEquals(1, bucket1.get().getVersion(), "初始版本应为 1");
        assertEquals("1", bucket1.get().getValue());

        // 更新
        workspace.writeKV("counter", "2", "tester");

        Optional<KVBucket> bucket2 = workspace.getKVBucket("counter");
        assertTrue(bucket2.isPresent());
        assertEquals(2, bucket2.get().getVersion(), "更新后版本应递增为 2");
        assertEquals("2", bucket2.get().getValue(), "更新后的值应变化");

        // 再次更新
        workspace.writeKV("counter", "3", "tester");

        Optional<KVBucket> bucket3 = workspace.getKVBucket("counter");
        assertTrue(bucket3.isPresent());
        assertEquals(3, bucket3.get().getVersion(), "二次更新后版本应递增为 3");
        assertEquals("3", bucket3.get().getValue(), "二次更新后的值应变化");
    }

    // ==================== 删除条目 ====================

    @Test
    void testDelete() {
        workspace.writeKV("temp", "value", "tester");
        assertTrue(workspace.readKV("temp").isPresent(), "删除前应能读取");

        workspace.delete("temp");
        assertTrue(workspace.readKV("temp").isEmpty(), "删除后读取应返回 empty");
    }

    // ==================== 列出 key ====================

    @Test
    void testListKeys() {
        // 写入多个 KV 和文档条目
        workspace.writeKV("user.name", "Alice", "tester");
        workspace.writeKV("user.age", "30", "tester");
        workspace.writeKV("config.theme", "dark", "tester");
        workspace.writeDoc("user.profile", "profile content", "text/plain", "tester");
        workspace.writeDoc("config.json", "{}", "application/json", "tester");

        // 列出所有 key（空前缀应当匹配所有）
        Set<String> allKeys = workspace.listKeys("");
        assertEquals(5, allKeys.size(), "应列出全部 5 个 key");
        assertTrue(allKeys.contains("user.name"));
        assertTrue(allKeys.contains("user.age"));
        assertTrue(allKeys.contains("user.profile"));
        assertTrue(allKeys.contains("config.theme"));
        assertTrue(allKeys.contains("config.json"));

        // 按前缀过滤
        Set<String> userKeys = workspace.listKeys("user.");
        assertEquals(3, userKeys.size(), "前缀 user. 应匹配 3 个 key");
        assertTrue(userKeys.contains("user.name"));
        assertTrue(userKeys.contains("user.age"));
        assertTrue(userKeys.contains("user.profile"));

        Set<String> configKeys = workspace.listKeys("config.");
        assertEquals(2, configKeys.size(), "前缀 config. 应匹配 2 个 key");
        assertTrue(configKeys.contains("config.theme"));
        assertTrue(configKeys.contains("config.json"));

        // 不存在的前缀应返回空集合
        Set<String> noMatch = workspace.listKeys("nonexistent.");
        assertTrue(noMatch.isEmpty(), "不匹配的前缀应返回空集合");
    }

    // ==================== 清空共享上下文 ====================

    @Test
    void testClear() {
        workspace.writeKV("k1", "v1", "tester");
        workspace.writeDoc("d1", "content", "text/plain", "tester");
        assertEquals(2, workspace.size(), "清空前 size 应为 2");

        workspace.clear();
        assertEquals(0, workspace.size(), "清空后 size 应为 0");
        assertTrue(workspace.readKV("k1").isEmpty(), "清空后读取 KV 应返回 empty");
        assertTrue(workspace.readDoc("d1").isEmpty(), "清空后读取文档应返回 empty");
    }

    // ==================== 最大条目数淘汰 ====================

    @Test
    void testMaxEntriesEviction() {
        // 使用 maxEntries=5 的项目
        SharedContextStore smallWorkspace = new SharedContextStore(5);

        // 写入 10 个 KV 条目
        for (int i = 0; i < 10; i++) {
            smallWorkspace.writeKV("key-" + i, "value-" + i, "tester");
        }

        // size 不应超过 5
        assertTrue(smallWorkspace.size() <= 5,
                "maxEntries=5 时写入 10 条，size 不应超过 5，实际为 " + smallWorkspace.size());

        // 同时验证最新写入的条目应存在（淘汰的是最旧的）
        for (int i = 5; i < 10; i++) {
            assertTrue(smallWorkspace.readKV("key-" + i).isPresent(),
                    "较新的 key-" + i + " 应存在");
        }
    }

    @Test
    void persistsEntriesAcrossWorkspaceInstances() {
        Path project = tempDir.resolve("project");
        SharedContextStore first = new SharedContextStore(100);
        first.writeKV(project, "task/context", "parent-data", "parent-session");
        first.writeDoc(project, "task/result", "sub-agent-data", "text/markdown", "parent-session");

        Path storeFile = project.resolve(".loopra/workspace/workspace.json");
        assertTrue(Files.isRegularFile(storeFile));

        SharedContextStore restarted = new SharedContextStore(100);
        assertEquals("parent-data", restarted.readKV(project, "task/context").orElseThrow());
        DocumentBucket document = restarted.readDoc(project, "task/result").orElseThrow();
        assertEquals("sub-agent-data", document.getContent());
        assertEquals("text/markdown", document.getMimeType());
        assertEquals("parent-session", document.getCreator());

        restarted.delete(project, "task/context");
        assertTrue(new SharedContextStore(100).readKV(project, "task/context").isEmpty());
    }

    @Test
    void isolatesPersistentEntriesByProjectDirectory() {
        Path firstProject = tempDir.resolve("first-project");
        Path secondProject = tempDir.resolve("second-project");
        workspace.writeKV(firstProject, "shared-key", "first", "tester");
        workspace.writeKV(secondProject, "shared-key", "second", "tester");

        SharedContextStore restarted = new SharedContextStore(100);
        assertEquals("first", restarted.readKV(firstProject, "shared-key").orElseThrow());
        assertEquals("second", restarted.readKV(secondProject, "shared-key").orElseThrow());
    }

    @Test
    void refusesToOverwriteUnreadableWorkspaceData() throws Exception {
        Path project = tempDir.resolve("corrupt-project");
        Path storeFile = project.resolve(".loopra/workspace/workspace.json");
        Files.createDirectories(storeFile.getParent());
        String corrupted = "{not valid json";
        Files.writeString(storeFile, corrupted);

        assertThrows(IllegalStateException.class,
                () -> new SharedContextStore(100).writeKV(project, "key", "value", "tester"));
        assertEquals(corrupted, Files.readString(storeFile));
    }

    @Test
    void reportsPersistenceFailureInsteadOfClaimingSuccess() throws Exception {
        Path fileRoot = tempDir.resolve("not-a-directory");
        Files.writeString(fileRoot, "not a directory");

        assertThrows(IllegalStateException.class,
                () -> workspace.writeKV(fileRoot, "key", "value", "tester"));
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {"kv", "document", "delete", "clear"})
    void failedMutationRestoresBothStoresAndAllowsRetry(String operation) throws Exception {
        Path project = tempDir.resolve("rollback-" + operation);
        workspace.writeKV(project, "shared", "original value", "tester");
        workspace.writeDoc(project, "shared", "original document", "text/plain", "tester");
        Path file = project.resolve(".loopra/workspace/workspace.json");
        String persisted = Files.readString(file);
        Files.delete(file);
        Files.createDirectory(file);
        // A nonempty directory at the destination makes replacement fail on every platform.
        Files.writeString(file.resolve("blocker"), "block");
        try {
            assertThrows(IllegalStateException.class, () -> {
                switch (operation) {
                    case "kv" -> workspace.writeKV(project, "shared", "changed", "tester");
                    case "document" -> workspace.writeDoc(project, "shared", "changed", "text/html", "tester");
                    case "delete" -> workspace.delete(project, "shared");
                    case "clear" -> workspace.clear(project);
                    default -> fail("Unknown mutation");
                }
            });
            assertEquals("original value", workspace.readKV(project, "shared").orElseThrow());
            assertEquals(1, workspace.getKVBucket(project, "shared").orElseThrow().getVersion());
            DocumentBucket document = workspace.readDoc(project, "shared").orElseThrow();
            assertEquals("original document", document.getContent());
            assertEquals("text/plain", document.getMimeType());
            assertEquals(1, document.getVersion());
        } finally {
            Files.delete(file.resolve("blocker"));
            Files.delete(file);
            Files.writeString(file, persisted);
        }
        workspace.writeKV(project, "retry", "succeeded", "tester");
        assertTrue(Files.readString(file).contains("succeeded"));
    }

    // ==================== 读取不存在的条目 ====================

    @Test
    void testReadNonExistent() {
        // 读取不存在的 KV key
        Optional<String> kvResult = workspace.readKV("nonexistent-kv");
        assertTrue(kvResult.isEmpty(), "读取不存在的 KV 应返回 empty");

        // 读取不存在的文档 key
        Optional<DocumentBucket> docResult = workspace.readDoc("nonexistent-doc");
        assertTrue(docResult.isEmpty(), "读取不存在的文档应返回 empty");

        // getKVBucket 对不存在的 key 也应返回 empty
        Optional<KVBucket> bucketResult = workspace.getKVBucket("nonexistent-bucket");
        assertTrue(bucketResult.isEmpty(), "getKVBucket 对不存在的 key 应返回 empty");
    }
}
