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
public class AcpSessionManager implements AcpSessionBackend {

    /** ACP sessionId → LoopraAgent（内存缓存，重启即失） */
    private final Map<String, SessionEntry> sessions = new ConcurrentHashMap<>();

    /** 共享配置 */
    private LoopraConfig config;

    private final java.util.function.Function<SessionStore.SessionModelSettings, LoopraModelProvider> providerFactory;

    public AcpSessionManager() { this(null); }
    public AcpSessionManager(java.util.function.Function<SessionStore.SessionModelSettings, LoopraModelProvider> providerFactory) {
        this.providerFactory = providerFactory;
        try {
            // Standalone ACP does not start Solon, so no @Init method initializes ConfigService.
            if (ConfigService.getConfig() == null) ConfigService.reload();
            this.config = ConfigService.getConfig();
        } catch (Exception e) {
            log.warn("[acp] 无法加载配置，使用默认值: {}", e.getMessage());
        }
    }

    @Override public boolean supportsMcpServers() { return true; }

    @Override public void setMcpServers(String sessionId, List<com.agentclientprotocol.sdk.spec.AcpSchema.McpServer> servers) {
        SessionEntry entry = sessions.get(sessionId);
        if (entry == null) throw new IllegalArgumentException("Session not found");
        if (!entry.lock().tryLock()) throw new IllegalStateException("会话正在运行");
        try {
            Map<String, com.agentclientprotocol.sdk.spec.AcpSchema.McpServer> effective = new java.util.LinkedHashMap<>();
            AcpMcpServers.managed(entry.workspace()).forEach(server -> effective.put(AcpMcpServers.name(server), server));
            if (servers != null) servers.forEach(server -> effective.put(AcpMcpServers.name(server), server));
            entry.agent().setAcpMcpServers(List.copyOf(effective.values()));
        }
        finally { entry.lock().unlock(); }
    }

    /**
     * Each session owns its model provider so switching one session never changes another.
     */
    private LoopraModelProvider modelProvider(SessionStore.SessionModelSettings settings) {
        if (providerFactory != null) return providerFactory.apply(settings);
        var channel = config.modelChannel(settings.modelChannelId());
        if (channel == null || channel.apiKey() == null || channel.apiKey().isBlank()) throw new IllegalStateException("请配置 Native 模型渠道和密钥");
        return new LoopraModelProvider(channel.apiUrl(), channel.apiKey(), settings.model(), settings.reasoningEffort(),
                channel.id(), channel.apiProtocol(), channel.specialCompatibility(), config.modelMaxTokens(channel.id(), settings.model()));
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
    private LoopraAgent buildAgent(Path workspacePath, String name) {
        SessionStore store = new JsonlSessionStore(ProjectRegistry.getOrCreate(workspacePath.toString()).getSessionsDir(workspacePath.toString()));
        var saved = store.getModelSettings(name);
        var settings = new SessionStore.SessionModelSettings(saved.model() == null ? config.model() : saved.model(),
                saved.modelChannelId() == null ? config.modelChannelId() : saved.modelChannelId(),
                saved.reasoningEffort() == null ? config.reasoningEffort() : saved.reasoningEffort());
        try {
            LoopraAgent agent = LoopraAgent.builder().modelProvider(modelProvider(settings)).sessionStore(store)
                    .config(config).environment(SessionEnvironment.local(workspacePath)).buildLightweight();
            agent.setReasoningEffort(settings.reasoningEffort());
            agent.setFastMode(config.fastMode());
            return agent;
        }
        catch (RuntimeException error) { store.shutdown(); throw error; }
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
        String sessionId = sessionName != null ? sessionName : "acp-" + UUID.randomUUID().toString();

        // 如果已在内存中，直接返回
        if (sessions.containsKey(sessionId)) {
            log.debug("[acp] 会话已存在于内存: {}", sessionId);
            return sessionId;
        }

        Path workspacePath = resolveWorkspace(cwd);
        LoopraAgent agent = buildAgent(workspacePath, sessionId);

        // ★ 关键：将 ACP sessionId 绑定为 Loopra 会话名
        // 这样所有聊天消息都会以 {sessionId}.jsonl 持久化到磁盘
        agent.getCtx().clearHistory();
        agent.bindSession(sessionId);

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
            return sessions.get(sessionId).workspace().toAbsolutePath().normalize().equals(resolveWorkspace(cwd).toAbsolutePath().normalize());
        }

        Path workspacePath = resolveWorkspace(cwd);

        // 2. 检查磁盘持久化文件
        try {
            Path sessionFile = ProjectRegistry.getOrCreate(workspacePath.toString())
                    .getSessionsDir(workspacePath.toString())
                    .resolve(sanitize(sessionId) + ".jsonl");

            if (!Files.exists(sessionFile)) {
                log.warn("[acp] 磁盘上不存在会话文件: {}", sessionFile);
                return false;
            }

            log.info("[acp] 从磁盘恢复会话: sessionId={}, file={}", sessionId, sessionFile);

            // 3. 重建 LoopraAgent
            LoopraAgent agent = buildAgent(workspacePath, sessionId);

            // 4. 绑定会话名并加载历史
            agent.getCtx().clearHistory();
            agent.bindSession(sessionId);
            var healed = MessageHealer.heal(agent.getCtx().getHistory());
            agent.getCtx().clearHistory();
            for (ChatMessage message : healed.messages()) agent.getCtx().injectHistory(message);

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
        return handlePrompt(sessionId, promptText, images, output, Map.of());
    }

    @Override
    public String handlePrompt(String sessionId, String promptText, List<String> images,
                                AcpAgentOutput output, Map<String, Object> options) throws IOException {
        SessionEntry entry = sessions.get(sessionId);
        if (entry == null) {
            throw new IllegalArgumentException("ACP 会话不存在: " + sessionId);
        }

        LoopraAgent agent = entry.agent();
        if (!entry.lock().tryLock()) throw new IllegalStateException("会话正在运行");

        // 设置 ACP 输出适配器（流式推送 session/update 通知）
        agent.setOutput(output);
        agent.setSessionId(sessionId);

        // 设置会话 ID 到 ThreadLocal，供 AI 请求头和日志使用
        LoopraModelProvider.CURRENT_LOG_SESSION.set(sessionId);

        try {
            // 构建用户消息
            UserMessage userMessage = UserMessage.of(promptText, images);

            // 执行 Agent 推理循环
            String result = AcpPromptExecutor.run(agent, output, () -> agent.chat(userMessage));

            // 文件变更已随每个工具结果的标准 ACP diff 内容下发，不再重复发送扩展事件。

            // 刷入会话
            agent.flushSession();
            agent.saveUsage();

            return result;
        } finally {
            agent.setOutput(site.sorghum.loopra.tool.AgentOutput.NOOP);
            LoopraModelProvider.CURRENT_LOG_SESSION.remove();
            entry.lock().unlock();
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
     * 供 ACP session/load 回放当前 Native 会话历史。
     */
    @Override
    public List<ChatMessage> history(String sessionId) {
        LoopraAgent agent = getAgent(sessionId);
        return agent == null ? List.of() : List.copyOf(agent.getCtx().getHistory());
    }

    @Override
    public boolean isCancelled(String sessionId) {
        LoopraAgent agent = getAgent(sessionId);
        return agent != null && agent.isAbortRequested();
    }

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
    public record SessionEntry(String sessionId, LoopraAgent agent, Path workspace, java.util.concurrent.locks.ReentrantLock lock) {
        SessionEntry(String id, LoopraAgent agent, Path workspace) { this(id, agent, workspace, new java.util.concurrent.locks.ReentrantLock()); }
    }

    @Override public List<com.agentclientprotocol.sdk.spec.AcpSchema.SessionConfigOption> configOptions(String sessionId) {
        LoopraAgent agent = getAgent(sessionId);
        if (agent == null) throw new IllegalArgumentException("Session not found");
        var values = new java.util.LinkedHashMap<>(agent.getCtx().getSessionStore().getAgentConfig(sessionId));
        values.put("mode", agent.getHitlMode());
        return NativeAcpConfig.options(config, new SessionStore.SessionModelSettings(agent.getModel(), agent.getModelChannelId(),
                agent.getReasoningEffort()), values, agent.isPlanMode());
    }

    @Override public void setConfigOption(String sessionId, String id, Object value) {
        SessionEntry entry = sessions.get(sessionId);
        if (entry == null) throw new IllegalArgumentException("Session not found");
        if (!entry.lock().tryLock()) throw new IllegalStateException("请等待当前回复结束后再修改 Native 配置");
        try {
            NativeAcpConfig.validate(configOptions(sessionId), id, value);
            LoopraAgent agent = entry.agent();
            SessionStore store = agent.getCtx().getSessionStore();
            if ("model".equals(id)) {
                var settings = NativeAcpConfig.modelSettings(config, value, agent.getReasoningEffort());
                store.setModelSettings(sessionId, settings.model(), settings.modelChannelId(), settings.reasoningEffort());
                if (java.util.Objects.equals(agent.getModelChannelId(), settings.modelChannelId())) {
                    agent.setModel(settings.model()); agent.setMaxTokens(config.modelMaxTokens(settings.modelChannelId(), settings.model()));
                } else {
                    agent.flushSession();
                    LoopraAgent replacement = buildAgent(entry.workspace(), sessionId);
                    replacement.setAcpMcpServers(agent.getAcpMcpServers());
                    replacement.getCtx().clearHistory(); replacement.bindSession(sessionId);
                    sessions.put(sessionId, new SessionEntry(sessionId, replacement, entry.workspace(), entry.lock()));
                    agent.dispose();
                }
            } else if ("effort".equals(id)) {
                store.setModelSettings(sessionId, agent.getModel(), agent.getModelChannelId(), (String) value);
                agent.setReasoningEffort((String) value);
            } else if ("plan".equals(id)) {
                if ("off".equals(value)) agent.clearPendingPlan();
                agent.setPlanMode("on".equals(value));
            } else {
                var values = new java.util.LinkedHashMap<>(store.getAgentConfig(sessionId));
                values.put(id, (String) value); store.setAgentConfig(sessionId, values);
                if ("mode".equals(id)) agent.setHitlMode((String) value);
                if ("fast".equals(id)) agent.setFastMode("on".equals(value));
            }
        } catch (IOException e) { throw new IllegalStateException("保存 Agent 配置失败", e); }
        finally { entry.lock().unlock(); }
    }

    // ==================== 工具方法 ====================

    /**
     * 清洗文件名，移除非法字符。
     */
    private static String sanitize(String name) {
        return name.replaceAll("[^a-zA-Z0-9_\\-]", "_");
    }
}
