package site.sorghum.loopra.bin.acp;

import lombok.extern.slf4j.Slf4j;
import site.sorghum.loopra.bin.agent.context.MessageHealer;
import site.sorghum.loopra.bin.agent.core.LoopraAgent;
import site.sorghum.loopra.bin.agent.environment.SessionEnvironment;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.bin.config.ConfigService;
import site.sorghum.loopra.bin.config.LoopraConfig;
import site.sorghum.loopra.bin.model.LoopraModelProvider;
import site.sorghum.loopra.bin.project.ProjectRegistry;
import site.sorghum.loopra.bin.session.JsonlSessionStore;
import site.sorghum.loopra.bin.session.SessionStore;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

/**
 * ACP 会话管理器 —— 管理 ACP sessionId → LoopraAgent 的映射。
 * <p>
 * 关键设计：ACP sessionId 直接作为 Loopra 会话名，通过 {@link SessionStore} 持久化到磁盘。
 * 重启后 {@link #loadOrRestoreSession(String, String)} 可按 sessionId 自动从磁盘重建。
 * </p>
 *
 * <h3>持久化路径</h3>
 * <pre>
 * ~/.loopra/workspace/{workspaceHash}/sessions/{acpSessionId}.jsonl
 * </pre>
 *
 * @author Sorghum
 */
@Slf4j
public class AcpSessionManager {

    /** ACP sessionId → LoopraAgent（内存缓存，重启即失） */
    private final Map<String, SessionEntry> sessions = new ConcurrentHashMap<>();

    /** 共享配置 */
    private LoopraConfig config;

    /** 共享 LoopraModelProvider（所有会话复用，减少资源消耗） */
    private volatile LoopraModelProvider sharedModelProvider;

    public AcpSessionManager() {
        try {
            this.config = ConfigService.getConfig();
            initSharedModelProvider();
        } catch (Exception e) {
            log.warn("[acp] 无法加载配置，使用默认值: {}", e.getMessage());
        }
    }

    /**
     * 根据配置创建共享 LoopraModelProvider。
     */
    private void initSharedModelProvider() {
        if (config == null) {
            log.warn("[acp] 配置为空，无法创建 LoopraModelProvider");
            return;
        }
        String apiUrl = config.apiUrl();
        String apiKey = config.apiKey();
        if (apiUrl == null || apiKey == null || apiKey.isEmpty()) {
            log.warn("[acp] API 配置不完整，LoopraModelProvider 暂不可用");
            return;
        }
        String model = config.model();
        this.sharedModelProvider = new LoopraModelProvider(apiUrl, apiKey, model, config.reasoningEffort(),
                config.modelChannelId(), config.apiProtocol(), config.specialCompatibility(),
                config.activeModelMaxTokens());
        log.info("[acp] 共享 LoopraModelProvider 初始化完成: model={}, apiUrl={}", model, apiUrl);
    }

    /**
     * 确保共享 LoopraModelProvider 已初始化，未初始化则尝试从配置重建。
     */
    private void ensureModelProvider() {
        if (sharedModelProvider == null) {
            ConfigService.reload();
            this.config = ConfigService.getConfig();
            initSharedModelProvider();
            if (sharedModelProvider == null) {
                throw new IllegalStateException(
                    "LoopraModelProvider 未初始化，请检查 ~/.loopra/config.json 中的 apiKey 和 baseUrl 配置");
            }
        }
    }

    /**
     * 创建项目路径。
     */
    private Path resolveWorkspace(String cwd) {
        return (cwd != null && !cwd.isEmpty())
                ? Path.of(cwd)
                : Path.of(System.getProperty("user.dir"));
    }

    /**
     * 构建轻量级 LoopraAgent。
     */
    private LoopraAgent buildAgent(Path workspacePath) {
        ensureModelProvider();

        LoopraAgent.Builder builder = LoopraAgent.builder();
        builder.modelProvider(sharedModelProvider);
        if (config != null) {
            builder.config(config);
        }
        builder.environment(SessionEnvironment.local(workspacePath));
        return builder.buildLightweight();
    }

    // ==================== 会话生命周期 ====================

    /**
     * 创建新 ACP 会话并创建对应的 LoopraAgent。
     * <p>
     * ACP sessionId 会绑定到 Loopra 的 SessionStore，后续所有聊天消息
     * 会自动通过 {@link JsonlSessionStore} 持久化到磁盘。
     * </p>
     *
     * @param cwd          工作目录
     * @param sessionName  可选的会话名称，为空则自动生成
     * @return 生成的 ACP sessionId
     */
    public String createSession(String cwd, String sessionName) {
        String sessionId = sessionName != null ? sessionName : "acp-" + UUID.randomUUID().toString().substring(0, 8);

        // 如果已在内存中，直接返回
        if (sessions.containsKey(sessionId)) {
            log.debug("[acp] 会话已存在于内存: {}", sessionId);
            return sessionId;
        }

        Path workspacePath = resolveWorkspace(cwd);
        LoopraAgent agent = buildAgent(workspacePath);

        // ★ 关键：将 ACP sessionId 绑定为 Loopra 会话名
        // 这样所有聊天消息都会以 {sessionId}.jsonl 持久化到磁盘
        agent.getCtx().getSessionStore().bindTo(sessionId);
        agent.setSessionId(sessionId);

        sessions.put(sessionId, new SessionEntry(sessionId, agent, workspacePath));
        log.info("[acp] 创建会话: sessionId={}, workspace={}", sessionId, workspacePath);
        return sessionId;
    }

    /**
     * 加载或恢复已有会话。
     * <p>
     * 优先级：内存缓存 → 磁盘持久化文件。
     * 如果磁盘上有 {@code {sessionId}.jsonl}，会自动重建 LoopraAgent
     * 并注入历史消息，实现重启后会话恢复。
     * </p>
     *
     * @param sessionId ACP 会话 ID
     * @param cwd       工作目录
     * @return true 表示成功加载/恢复，false 表示会话完全不存在
     */
    public boolean loadOrRestoreSession(String sessionId, String cwd) {
        // 1. 检查内存缓存
        if (sessions.containsKey(sessionId)) {
            log.debug("[acp] 从内存加载会话: {}", sessionId);
            return true;
        }

        Path workspacePath = resolveWorkspace(cwd);

        // 2. 检查磁盘持久化文件
        try {
            String hash = ProjectRegistry.computeProjectHash(workspacePath.toAbsolutePath().toString());
            Path sessionFile = ProjectRegistry.getOrCreate(workspacePath.toString())
                    .getSessionsDir(workspacePath.toString())
                    .resolve(sanitize(sessionId) + ".jsonl");

            if (!Files.exists(sessionFile)) {
                log.warn("[acp] 磁盘上不存在会话文件: {}", sessionFile);
                return false;
            }

            log.info("[acp] 从磁盘恢复会话: sessionId={}, file={}", sessionId, sessionFile);

            // 3. 重建 LoopraAgent
            LoopraAgent agent = buildAgent(workspacePath);

            // 4. 绑定会话名并加载历史
            agent.getCtx().getSessionStore().bindTo(sessionId);
            agent.setSessionId(sessionId);

            // 5. 从 JSONL 加载历史消息并注入上下文
            List<ChatMessage> history = agent.getCtx().getSessionStore().load(sessionId);
            if (history != null && !history.isEmpty()) {
                // Healing：修复可能截断的消息
                var healResult = MessageHealer.heal(history);
                for (ChatMessage msg : healResult.messages()) {
                    agent.getCtx().injectHistory(msg);
                }
                log.info("[acp] 已恢复 {} 条历史消息", healResult.messages().size());
            }

            // 6. 恢复 token 用量
            long[] usage = agent.getCtx().getSessionStore().loadUsage(sessionId);
            if (usage != null && usage.length >= 4) {
                agent.addUsage((int) usage[0], (int) usage[1], (int) usage[2], (int) usage[3]);
            }

            sessions.put(sessionId, new SessionEntry(sessionId, agent, workspacePath));
            return true;

        } catch (Exception e) {
            log.error("[acp] 从磁盘恢复会话失败: sessionId={}, error={}", sessionId, e.getMessage(), e);
            return false;
        }
    }

    /**
     * 处理 ACP session/prompt。
     */
    public String handlePrompt(String sessionId, String promptText, List<String> images,
                                AcpAgentOutput output) throws IOException {
        SessionEntry entry = sessions.get(sessionId);
        if (entry == null) {
            throw new IllegalArgumentException("ACP 会话不存在: " + sessionId);
        }

        LoopraAgent agent = entry.agent();

        // 设置 ACP 输出适配器（流式推送 session/update 通知）
        agent.setOutput(output);
        agent.setSessionId(sessionId);

        // 设置会话 ID 到 ThreadLocal，供 AI 请求头和日志使用
        LoopraModelProvider.CURRENT_LOG_SESSION.set(sessionId);

        try {
            // 构建用户消息
            UserMessage userMessage = UserMessage.of(promptText, images);

            // 执行 Agent 推理循环
            String result = agent.chat(userMessage);

            // 刷入会话
            agent.flushSession();
            agent.saveUsage();

            return result;
        } finally {
            LoopraModelProvider.CURRENT_LOG_SESSION.remove();
        }
    }

    /**
     * 中断指定会话的正在进行的 prompt。
     */
    public void cancelPrompt(String sessionId) {
        SessionEntry entry = sessions.get(sessionId);
        if (entry != null) {
            entry.agent().abort();
            log.info("[acp] 已中断会话: {}", sessionId);
        }
    }

    /**
     * 关闭并释放 ACP 会话。
     */
    public void closeSession(String sessionId) {
        SessionEntry entry = sessions.remove(sessionId);
        if (entry != null) {
            try {
                entry.agent().flushSession();
                entry.agent().saveUsage();
                entry.agent().dispose();
            } catch (Exception e) {
                log.warn("[acp] 释放会话资源失败: sessionId={}, error={}", sessionId, e.getMessage());
            }
            log.info("[acp] 关闭会话: {}", sessionId);
        }
    }

    /**
     * 获取所有活跃会话的 SessionInfo 列表（用于 ACP session/list）。
     */
    public List<SessionInfo> listSessions() {
        return sessions.values().stream()
                .map(e -> new SessionInfo(e.sessionId(), e.workspace().toAbsolutePath().toString()))
                .collect(Collectors.toList());
    }

    /**
     * SessionInfo 简略信息。
     */
    public record SessionInfo(String sessionId, String cwd) {}

    /**
     * 获取指定会话的 LoopraAgent。
     */
    public LoopraAgent getAgent(String sessionId) {
        SessionEntry entry = sessions.get(sessionId);
        return entry != null ? entry.agent() : null;
    }

    /**
     * 释放所有会话（应用关闭时调用）。
     */
    public void dispose() {
        sessions.values().forEach(entry -> {
            try {
                entry.agent().flushSession();
                entry.agent().saveUsage();
                entry.agent().dispose();
            } catch (Exception e) {
                log.warn("[acp] dispose 异常: {}", e.getMessage());
            }
        });
        sessions.clear();
        log.info("[acp] 已释放所有 ACP 会话");
    }

    /**
     * 会话条目记录。
     */
    public record SessionEntry(String sessionId, LoopraAgent agent, Path workspace) {}

    // ==================== 工具方法 ====================

    /**
     * 清洗文件名，移除非法字符。
     */
    private static String sanitize(String name) {
        return name.replaceAll("[^a-zA-Z0-9_\\-]", "_");
    }
}
