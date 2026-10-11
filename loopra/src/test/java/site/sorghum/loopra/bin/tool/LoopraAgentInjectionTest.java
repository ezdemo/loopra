package site.sorghum.loopra.bin.tool;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.noear.snack4.ONode;
import org.noear.solon.ai.chat.tool.FunctionToolDesc;
import org.noear.solon.ai.chat.tool.ToolHandler;
import site.sorghum.loopra.bin.agent.core.AgentLoop;
import site.sorghum.loopra.bin.agent.core.LoopraAgent;
import site.sorghum.loopra.bin.agent.environment.SessionEnvironment;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.bin.agent.prompt.PromptPrefix;
import site.sorghum.loopra.bin.agent.spi.ToolPolicyProvider;
import site.sorghum.loopra.bin.config.LoopraConfig;
import site.sorghum.loopra.bin.model.TestLoopraProvider;
import site.sorghum.loopra.bin.session.JsonlSessionStore;
import site.sorghum.loopra.bin.session.SessionStore;
import site.sorghum.loopra.integration.cutin.CutinMessageBridge;

import java.io.BufferedWriter;
import java.io.IOException;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

/**
 * LoopraAgent Builder 注入点装配测试 ——
 * 覆盖 docs/loopra-modular-refactor.md 遗留项 5.1（toolSystem 注入）与 5.2（SessionStore 生命周期归属）。
 * <p>
 * 与包私有 {@link ToolSystemInitializer.ToolSystem} 构造器同包，仅为构造注入结果；
 * 测试对象为公共 API {@link LoopraAgent.Builder}。
 * </p>
 *
 * @author Sorghum
 */
class LoopraAgentInjectionTest {

    /**
     * 隔离的 user.home（LoopraConfig.load 会写 ~/.loopra/config.json）。
     * 不用 @TempDir：chat 路径的 DJL 分词器会往 user.home 释放原生 DLL，
     * 被 JVM 加载后 Windows 无法删除，@TempDir 清理会直接报错；改为手动创建、不强制删除。
     */
    private static Path home;
    /** Agent 项目（会话文件写入此处的 .loopra 下） */
    @TempDir
    Path workspace;

    private String originalUserHome;

    @BeforeAll
    static void createIsolatedHome() throws IOException {
        home = Files.createTempDirectory("loopra-agent-injection-home");
    }

    @BeforeEach
    void isolateUserHome() {
        originalUserHome = System.getProperty("user.home");
        System.setProperty("user.home", home.toString());
    }

    @AfterEach
    void restoreUserHome() {
        System.setProperty("user.home", originalUserHome);
    }

    @Test
    void reusesInjectedToolSystemAndSkipsInitialize() throws Exception {
        ToolRegistry shared = new ToolRegistry().setDisabledTools(Set.of());
        shared.register(tool("marker_tool", args -> "ok"));
        String markerPrompt = "MARKER_SYSTEM_PROMPT_FOR_TEST";
        PromptPrefix prefix = new PromptPrefix(markerPrompt, shared.toOpenAiTools());
        ToolSystemInitializer.ToolSystem sharedResult =
                new ToolSystemInitializer.ToolSystem(shared, prefix);

        AtomicReference<List<ChatMessage>> lastMessages = new AtomicReference<>();
        TestLoopraProvider client = TestLoopraProvider.builder()
                .model("stub-model")
                .stream(request -> {
                    lastMessages.set(CutinMessageBridge.toLoopra(request.messages()));
                    return TestLoopraProvider.contentStream("hello-from-stub");
                })
                .build();
        LoopraAgent agent = LoopraAgent.builder()
                .config(LoopraConfig.load())
                .modelProvider(client)
                .environment(SessionEnvironment.local(workspace))
                .toolSystem(sharedResult)
                // 单测无 Solon 容器，默认 ConfigServiceToolPolicyProvider 读不到配置；
                // 注入空策略替身（也顺便验证该注入点生效）
                .toolPolicyProvider(EMPTY_TOOL_POLICY)
                .buildLightweight();
        try {
            String reply = agent.chat(UserMessage.of("hi"));

            assertEquals("hello-from-stub", reply);
            // 注入的 registry 实例被原样装配进推理循环（若走了 initialize 则会是新实例）
            assertSame(shared, loopOf(agent).getToolRegistry(),
                    "推理循环应直接使用注入的共享 ToolRegistry");
            // 注入的 PromptPrefix 原样进入 system prompt（若走了 initialize，前缀会被重建）
            assertTrue(lastMessages.get().get(0).isSystem());
            assertTrue(lastMessages.get().get(0).getContent().contains(markerPrompt),
                    "system prompt 应来自注入的 PromptPrefix");
        } finally {
            agent.dispose();
        }
    }

    @Test
    void disposeDoesNotShutdownInjectedSessionStore() {
        RecordingSessionStore store = new RecordingSessionStore();
        LoopraAgent agent = LoopraAgent.builder()
                .config(LoopraConfig.load())
                .modelProvider(TestLoopraProvider.returning("hello-from-stub"))
                .environment(SessionEnvironment.local(workspace))
                .sessionStore(store)
                .buildLightweight();

        assertSame(store, agent.getCtx().getSessionStore());
        agent.dispose();

        assertEquals(0, store.shutdownCalls,
                "上层注入的共享 SessionStore 不应被 Agent 关闭，生命周期归注入方");
    }

    @Test
    void disposeShutdownsSelfBuiltSessionStore() throws Exception {
        LoopraAgent agent = LoopraAgent.builder()
                .config(LoopraConfig.load())
                .modelProvider(TestLoopraProvider.returning("hello-from-stub"))
                .environment(SessionEnvironment.local(workspace))
                .buildLightweight();

        SessionStore store = agent.getCtx().getSessionStore();
        assertInstanceOf(JsonlSessionStore.class, store);
        // 触发一次写入使 writer 句柄打开，作为 dispose 后可观察的关闭信号
        store.append(ChatMessage.ofUser("warm-up"));
        assertNotNull(writerOf((JsonlSessionStore) store), "dispose 前写入句柄应已打开");

        agent.dispose();

        assertNull(writerOf((JsonlSessionStore) store),
                "未注入 SessionStore 时 Agent 自建存储，dispose 必须关闭它");
    }

    // ==================== 测试替身 ====================

    /** 空工具策略：不禁用、不覆盖只读。 */
    private static final ToolPolicyProvider EMPTY_TOOL_POLICY = new ToolPolicyProvider() {
        @Override
        public Set<String> disabledTools() {
            return Set.of();
        }

        @Override
        public Map<String, Boolean> toolReadOnlyOverrides() {
            return Map.of();
        }
    };

    /** 读取 JsonlSessionStore 内部 writer 句柄，作为"已关闭"的可观察信号（null = 已关闭）。 */
    private static BufferedWriter writerOf(JsonlSessionStore store) throws Exception {
        Field field = JsonlSessionStore.class.getDeclaredField("writer");
        field.setAccessible(true);
        return (BufferedWriter) field.get(store);
    }

    /** LoopraAgent 未暴露内部 AgentLoop，测试经反射访问以断言装配同一性。 */
    private static AgentLoop loopOf(LoopraAgent agent) throws Exception {
        Field field = LoopraAgent.class.getDeclaredField("loop");
        field.setAccessible(true);
        return (AgentLoop) field.get(agent);
    }

    private static FunctionToolDesc tool(String name, ToolHandler handler) {
        return new FunctionToolDesc(name)
                .description(name)
                .inputSchema("{\"type\":\"object\"}")
                .returnType(String.class)
                .doHandle(handler);
    }

    /** 最小 SessionStore 替身，仅统计 shutdown 调用次数。 */
    private static final class RecordingSessionStore implements SessionStore {
        private String current = "recording-session";
        int shutdownCalls = 0;

        @Override
        public String currentName() {
            return current;
        }

        @Override
        public String newSessionName() {
            return "recording-" + System.nanoTime();
        }

        @Override
        public boolean bindTo(String name) {
            this.current = name;
            return true;
        }

        @Override
        public void append(ChatMessage message) {
        }

        @Override
        public List<ChatMessage> load() {
            return new ArrayList<>();
        }

        @Override
        public List<ChatMessage> load(String name) {
            return new ArrayList<>();
        }

        @Override
        public void rewrite(List<ChatMessage> messages) {
        }

        @Override
        public List<SessionInfo> list() {
            return new ArrayList<>();
        }

        @Override
        public boolean delete(String name) {
            return true;
        }

        @Override
        public void clearAll() {
        }

        @Override
        public void flush() {
        }

        @Override
        public void saveUsage(String name, long prompt, long completion, long cacheHit, long cacheMiss) {
        }

        @Override
        public void saveUsage(String name, long prompt, long completion,
                              long cacheHit, long cacheMiss, long lastPromptTokens) {
        }

        @Override
        public long[] loadUsage(String name) {
            return new long[5];
        }

        @Override
        public void saveModelUsage(String name, Map<String, long[]> modelUsage) {
        }

        @Override
        public Map<String, long[]> loadModelUsage(String name) {
            return new LinkedHashMap<>();
        }

        @Override
        public void updateTitle(String name, String title) {
        }

        @Override
        public String getTitle(String name) {
            return null;
        }

        @Override
        public void shutdown() {
            shutdownCalls++;
        }
    }
}
