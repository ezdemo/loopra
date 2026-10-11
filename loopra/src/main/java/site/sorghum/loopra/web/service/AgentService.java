package site.sorghum.loopra.web.service;

import lombok.Getter;
import lombok.extern.slf4j.Slf4j;
import org.noear.solon.annotation.Component;
import org.noear.solon.annotation.Destroy;
import org.noear.solon.annotation.Init;
import org.noear.solon.annotation.Inject;
import site.sorghum.loopra.bin.agent.context.ConversationContext;
import site.sorghum.loopra.bin.agent.core.LoopraAgent;
import site.sorghum.loopra.bin.agent.environment.SessionEnvironment;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.bin.command.ChatCommandRegistry;
import site.sorghum.loopra.bin.config.ConfigService;
import site.sorghum.loopra.bin.config.LoopraConfig;
import site.sorghum.loopra.bin.project.ProjectRegistry;
import site.sorghum.loopra.bin.project.ProjectRuntimeAccess;
import site.sorghum.loopra.bin.session.JsonlSessionStore;
import site.sorghum.loopra.bin.session.SessionStore;
import site.sorghum.loopra.bin.session.SubAgentSessionStore;
import site.sorghum.loopra.bin.tool.ToolRegistry;
import site.sorghum.loopra.bin.tool.ToolSystemInitializer;
import site.sorghum.loopra.tool.AgentOutput;
import site.sorghum.loopra.tool.solon.common.SessionTerminalTalent.BashSessionInfo;
import site.sorghum.loopra.tool.solon.common.SessionTerminalTalent;
import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.model.AgentStatusDTO;
import site.sorghum.loopra.web.model.BashSessionDTO;
import site.sorghum.loopra.web.model.BashSessionLogDTO;
import site.sorghum.loopra.web.model.CommandMetaDTO;
import site.sorghum.loopra.web.model.ProjectCapabilitiesDTO;
import site.sorghum.loopra.web.model.ProjectInfoDTO;
import site.sorghum.loopra.web.model.SessionInfoDTO;
import site.sorghum.loopra.web.model.SessionSettingsDTO;
import site.sorghum.loopra.web.model.SessionStatusDTO;
import site.sorghum.loopra.web.model.UsageDTO;
import site.sorghum.loopra.web.model.WorktreeStatusDTO;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;
import java.util.stream.Collectors;

/**
 * Agent 会话级服务 —— 管理 LoopraAgent 的生命周期和并发访问。
 * <p>
 * 实现"一个会话一个 Agent"架构：
 * - 每个会话（workspacePath::sessionName）拥有独立的 LoopraAgent 实例
 * - 每个 Agent 独立持有模型 Provider，同一执行环境复用 ToolRegistry
 * - 每个 Agent 有自己的 ReentrantLock，支持并发聊天
 * - 使用 LRU 缓存策略管理 Agent 实例数量
 * @author Sorghum
 */
@Slf4j
@Component
public class AgentService implements ProjectRuntimeAccess {

    /**
     * 最大缓存 Agent 数量
     */
    private static final int MAX_CACHE_SIZE = 50;
    private final Object runtimeMonitor = new Object();
    @Inject
    ChatCommandRegistry commandRegistry;

    /**
     * 会话级 Agent 缓存
     */
    private final SessionAgentRegistry sessionCache = new SessionAgentRegistry(MAX_CACHE_SIZE, this::onAgentEvicted);

    private final ProjectCatalog projectCatalog = new ProjectCatalog(sessionCache::keySet);

    /** 会话模型设置的读取、解析与持久化。 */
    private final SessionSettingsService sessionSettingsService =
            new SessionSettingsService(this::sessionStoreFor);

    private final SessionUsageService sessionUsageService = new SessionUsageService();

    private final SessionAgentFactory sessionAgentFactory = new SessionAgentFactory(
            () -> commandRegistry, this::resolveSessionEnvironment, this::getOrCreateSharedToolSystem);

    /**
     * 默认项目的共享 ToolRegistry（供 /api/tools 等接口与就绪检查使用）
     */
    @Getter
    private volatile ToolRegistry sharedToolRegistry;

    /**
     * 按规范化的项目根、执行根和状态根缓存共享工具系统。
     * <p>同一项目的所有会话 Agent 复用其 ToolRegistry 与 PromptPrefix，
     * 避免每个 Agent 重复扫描工具/构建提示词；配置重建（{@link #reinitialize()}）时清空。</p>
     */
    private final ConcurrentHashMap<SessionEnvironment, ToolSystemInitializer.ToolSystem> sharedToolSystems =
            new ConcurrentHashMap<>();

    private final ProjectCapabilitiesService projectCapabilitiesService = new ProjectCapabilitiesService(
            runtimeMonitor, sessionCache, this::invalidateProjectToolSystems);

    /**
     * 加载默认系统提示词。
     * <p>
     * 基底固定为硬编码 {@code DEFAULT_SYSTEM_PROMPT}（含核心身份规则与记忆引导）；
     * 若用户级 {@code ~/.loopra/loopra.md} 存在且非空，则拼接在其后，保证两者都有。
     * 顺序：稳定的硬编码部分在前（利于 KV 前缀缓存），用户自定义部分在后。
     * </p>
     */
    private static String loadDefaultSystemPrompt() {
        String base = LoopraAgent.Builder.DEFAULT_SYSTEM_PROMPT;
        Path homePrompt = Paths.get(System.getProperty("user.home"), ".loopra", "loopra.md");
        if (!Files.exists(homePrompt)) {
            return base;
        }
        try {
            String content = Files.readString(homePrompt);
            if (content.trim().isEmpty()) {
                return base;
            }
            log.info("[prompt] 拼接用户级 ~/.loopra/loopra.md（{} 字符）", content.length());
            return base + "\n\n" + content.trim();
        } catch (IOException e) {
            log.error("[prompt] 读取 ~/.loopra/loopra.md 失败: {}", e.getMessage());
            return base;
        }
    }

    // ==================== 配置 getter（统一从 ConfigService 读取） ====================

    public String getSharedApiUrl() {
        LoopraConfig cfg = ConfigService.getConfig();
        return cfg != null ? cfg.apiUrl() : null;
    }

    public String getSharedApiKey() {
        LoopraConfig cfg = ConfigService.getConfig();
        return cfg != null ? cfg.apiKey() : null;
    }

    public String getSharedModel() {
        LoopraConfig cfg = ConfigService.getConfig();
        return cfg != null ? cfg.model() : null;
    }

    /**
     * 初始化共享组件（Solon 启动后自动调用）
     */
    @Init
    public void init() {
        try {
            ConfigService.reload();
            if (!buildSharedComponents(ConfigService.getConfig())) {
                log.error("[web] 未配置 apiKey，Agent 未初始化");
            } else {
                log.info("[web] Agent 共享组件初始化完成 — 模型: {}", getSharedModel());
            }
        } catch (Exception e) {
            log.error("Agent 共享组件初始化失败: ", e);
        }
    }

    /**
     * 销毁所有缓存的 Agent 和共享组件，然后重新从 config.json 初始化。
     * <p>
     * 适用于 baseUrl / apiKey 等不可热更新的配置变更后调用，
     * 下次聊天请求时 {@link #getOrCreateAgent} 会按全新配置重建 Agent。
     * </p>
     */
    public void reinitialize() {
        synchronized (runtimeMonitor) {
            reinitializeRuntime();
        }
    }

    private void reinitializeRuntime() {
        log.info("[config] 开始重新初始化 AgentService...");

        // 释放缓存 Agent 及其监听、会话存储和插件资源。
        sessionCache.clear();
        sharedToolSystems.clear();

        // 重新加载配置并构建共享组件
        try {
            ConfigService.reload();
            if (!buildSharedComponents(ConfigService.getConfig())) {
                log.error("[config] 未配置 apiKey，重新初始化失败");
            } else {
                log.info("[config] AgentService 重新初始化完成 — 模型: {}, API: {}", getSharedModel(), getSharedApiUrl());
            }
        } catch (Exception e) {
            log.error("[config] 重新初始化 AgentService 失败", e);
        }
    }

    /**
     * 根据配置构建默认项目的共享工具系统。
     * <p>
     * 抽取自 {@link #init()} 和 {@link #reinitialize()} 中的重复逻辑，
     * 单一职责：加载配置并初始化共享字段，不含缓存清理等上下文操作。
     * </p>
     *
     * @param config 已加载的 Loopra 配置
     * @return true 表示初始化成功，false 表示缺少必要的 API Key
     */
    private boolean buildSharedComponents(LoopraConfig config) {
        String apiKey = config.apiKey();

        if (apiKey == null || apiKey.isEmpty()) {
            return false;
        }

        // 设置禁用工具
        Set<String> disabledTools = config.disabledTools();
        if (disabledTools != null && !disabledTools.isEmpty()) {
            log.info("[config] 已禁用工具: {}", String.join(", ", disabledTools));
        }

        // 屏蔽目录列表
        final List<String> blockedPaths = config.blockedPaths();
        if (blockedPaths != null && !blockedPaths.isEmpty()) {
            log.info("[config] 已屏蔽目录: {}", String.join(", ", blockedPaths));
        }

        // 预构建默认项目的共享工具系统（其余项目在创建 Agent 时按需构建）
        SessionEnvironment environment = SessionEnvironment.of(config.workspaceDir(), null);
        ToolSystemInitializer.ToolSystem initResult = ToolSystemInitializer.initialize(
                environment, config.disabledTools(), loadDefaultSystemPrompt());
        sharedToolSystems.put(environmentKey(environment), initResult);
        this.sharedToolRegistry = initResult.toolRegistry();

        return true;
    }

    private ToolSystemInitializer.ToolSystem getOrCreateSharedToolSystem(SessionEnvironment environment) {
        SessionEnvironment key = environmentKey(environment);
        return sharedToolSystems.computeIfAbsent(key,
                k -> ToolSystemInitializer.initialize(
                        environment,
                        ConfigService.getConfig().disabledTools(),
                        loadDefaultSystemPrompt()));
    }

    private static SessionEnvironment environmentKey(SessionEnvironment environment) {
        if (environment == null) return SessionEnvironment.local(null);
        return new SessionEnvironment(normalizeWorkspace(environment.projectRoot()),
                normalizeWorkspace(environment.executionRoot()), normalizeWorkspace(environment.stateRoot()));
    }

    private static Path normalizeWorkspace(Path workspace) {
        return workspace == null ? null : workspace.toAbsolutePath().normalize();
    }

    /**
     * 生成会话唯一标识。
     *
     * @param workspacePath 项目路径
     * @param sessionName   会话名称
     * @return 唯一标识
     */
    private String generateSessionKey(String workspacePath, String sessionName) {
        // 使用默认项目路径（如果未指定）
        if (workspacePath == null || workspacePath.isEmpty()) {
            LoopraConfig cfg = ConfigService.getConfig();
            if (cfg != null && cfg.workspaceDir() != null) {
                workspacePath = cfg.workspaceDir().toAbsolutePath().toString();
            } else {
                workspacePath = Paths.get(System.getProperty("user.home"), ".loopra").toString();
            }
        }
        // 使用默认会话名称（如果未指定）
        if (sessionName == null || sessionName.isEmpty()) {
            sessionName = "default";
        }
        return workspacePath + "::" + sessionName;
    }

    /** 登记先于入队，并与项目刷新共享协调锁。 */
    public void registerSessionTask(String workspacePath, String sessionName, String requestId) {
        if (requestId == null || requestId.isBlank()) return;
        synchronized (runtimeMonitor) {
            sessionCache.registerTask(generateSessionKey(workspacePath, sessionName), requestId);
        }
    }

    /** 移除指定会话任务登记；不会误删同一会话随后登记的任务。 */
    public void unregisterSessionTask(String workspacePath, String sessionName, String requestId) {
        if (requestId == null || requestId.isBlank()) return;
        sessionCache.unregisterTask(generateSessionKey(workspacePath, sessionName), requestId);
        applyPendingProjectMcpRefresh(workspacePath);
    }

    /** 状态来自活动请求和 Agent 运行标志，不根据历史消息推断。 */
    public SessionStatusDTO getSessionStatus(String workspacePath, String sessionName) {
        return sessionCache.status(generateSessionKey(workspacePath, sessionName));
    }

    public ProjectCapabilitiesDTO getProjectCapabilities(String workspacePath) {
        return projectCapabilitiesService.get(workspacePath);
    }

    /** 工具只登记刷新，等待项目全部会话结束后才关闭旧 MCP 连接。 */
    @Override
    public String requestProjectMcpRefresh(String workspacePath) {
        return projectCapabilitiesService.requestRefresh(workspacePath);
    }

    public ProjectCapabilitiesDTO refreshProjectCapabilities(String workspacePath) {
        return projectCapabilitiesService.refresh(workspacePath);
    }

    private Set<Path> invalidateProjectToolSystems(Path projectRoot) {
        LoopraConfig config = ConfigService.getConfig();
        Path defaultProject = config == null ? null : config.workspaceDir();
        if (defaultProject != null && projectRoot.equals(defaultProject.toAbsolutePath().normalize())
                && sharedToolRegistry != null) {
            sharedToolRegistry.clearTools();
        }
        Set<Path> providerRoots = new HashSet<>();
        sharedToolSystems.keySet().removeIf(environment -> {
            if (!projectRoot.equals(environment.projectRoot())) return false;
            if (environment.executionRoot() != null) providerRoots.add(environment.executionRoot());
            return true;
        });
        return providerRoots;
    }

    private void applyPendingProjectMcpRefresh(String workspacePath) {
        projectCapabilitiesService.applyPending(workspacePath != null ? workspacePath : getCurrentProject());
    }

    /**
     * 列出 bash_start 启动的后台命令会话镜像。
     *
     * @param workspacePath 项目绝对路径；为空时返回全部项目的会话
     */
    public List<BashSessionDTO> listBashSessions(String workspacePath) {
        Path target = workspacePath == null || workspacePath.isEmpty()
                ? null : Paths.get(workspacePath).toAbsolutePath().normalize();
        List<BashSessionDTO> result = new ArrayList<>();
        for (BashSessionInfo info : SessionTerminalTalent.aggregateBashSessions()) {
            if (target != null && !target.equals(Paths.get(info.getWorkspace()))) {
                continue;
            }
            result.add(new BashSessionDTO(
                    info.getSessionId(), info.getWorkspace(), info.getCommand(),
                    info.getWorkdir(), info.getStartedAt(), info.getStatus()));
        }
        return result;
    }

    /**
     * 手动关闭指定 bash 后台会话（前端“手动关闭”按钮）。
     *
     * @param sessionId     命令会话 ID
     * @param workspacePath 项目绝对路径；为空时在所有项目中查找
     * @return 终止后的状态日志文本；未找到会话返回 null
     */
    public String terminateBashSession(String sessionId, String workspacePath) {
        return SessionTerminalTalent.terminateBashSession(sessionId, workspacePath, "用户手动关闭");
    }

    /**
     * 读取指定 bash 后台会话的累积输出日志（前端“查看日志”按钮）。
     *
     * @param sessionId     命令会话 ID
     * @param workspacePath 项目绝对路径；为空时在所有项目中查找
     * @return 会话日志 DTO；未找到会话返回 null
     */
    public BashSessionLogDTO readBashSessionLog(String sessionId, String workspacePath) {
        BashSessionInfo info = SessionTerminalTalent.findBashSession(sessionId, workspacePath);
        if (info == null) return null;
        return new BashSessionLogDTO(
                info.getSessionId(), info.getWorkspace(), info.getCommand(),
                info.getWorkdir(), info.getStatus(), info.getOutput());
    }

    // ==================== 状态查询 ====================

    /**
     * 获取或创建会话级 Agent。
     *
     * @param sessionKey 会话唯一标识
     * @return Agent 实例
     */
    private LoopraAgent getOrCreateAgent(String sessionKey) {
        return getOrCreateAgent(sessionKey, resolveSessionModelSettings(sessionKey, null, null, null));
    }

    /**
     * 获取会话 Agent，并确保它连接到本次请求指定的模型渠道。
     * 同一会话的调用方已持有会话锁，因此渠道切换不会与流式响应并发发生。
     */
    private LoopraAgent getOrCreateAgent(String sessionKey, SessionStore.SessionModelSettings settings) {
        // 更新访问顺序并检查缓存
        LoopraAgent agent = sessionCache.get(sessionKey);
        if (agent != null) {
            if (Objects.equals(agent.getModel(), settings.model())
                    && Objects.equals(agent.getModelChannelId(), settings.modelChannelId())) {
                agent.setReasoningEffort(settings.reasoningEffort());
                return agent;
            }
            if (Objects.equals(agent.getModelChannelId(), settings.modelChannelId())) {
                agent.setModel(settings.model());
                agent.setMaxTokens(ConfigService.getConfig().modelMaxTokens(settings.modelChannelId(), settings.model()));
                agent.setReasoningEffort(settings.reasoningEffort());
                return agent;
            }

            // 渠道切换需要替换 LoopraModelProvider；先落盘，再从同一会话历史恢复新 Agent。
            // 若主循环仍在运行（如需求池后台任务），先请求中断，
            // 避免旧循环继续执行工具且停止请求打到重建后的新实例上。
            if (agent.isRunning()) {
                log.info("[web] 会话模型渠道切换时主循环正在运行，先请求中断: {}", sessionKey);
                agent.abort();
            }
            agent.flushSession();
            sessionCache.remove(sessionKey);
            agent.dispose();
            agent = createAgent(sessionKey, settings, null);
            sessionCache.put(sessionKey, agent);
            log.info("[web] 会话模型渠道已切换: {}, {}/{}", sessionKey, settings.modelChannelId(), settings.model());
            return agent;
        }

        // 创建新 Agent
        synchronized (runtimeMonitor) {
            // 双重检查
            agent = sessionCache.get(sessionKey);
            if (agent != null) {
                return getOrCreateAgent(sessionKey, settings);
            }

            // LRU 淘汰
            sessionCache.evictIfNeeded();
            agent = createAgent(sessionKey, settings, null);

            // 缓存 Agent
            sessionCache.put(sessionKey, agent);

            log.info("[web] 创建新 Agent: {}", sessionKey);
            return agent;
        }
    }

    private LoopraAgent createAgent(String sessionKey, SessionStore.SessionModelSettings settings,
                                    String systemPrompt) {
        String[] parts = sessionKey.split("::", 2);
        String workspacePath = parts[0];
        String sessionName = parts.length > 1 ? parts[1] : "default";
        return sessionAgentFactory.create(workspacePath, sessionName, settings, systemPrompt,
                ConfigService.getConfig());
    }

    private SessionEnvironment resolveSessionEnvironment(String workspacePath, String sessionName) {
        // 会话级隔离分支模式：文件根指向隔离分支，会话身份/Goal/Checklist 仍归属主项目。
        // 懒创建：首个开启该模式的会话在 Agent 创建时创建 worktree；
        // 非 Git 仓库时明确失败，避免静默退化为直接改主项目。
        Path fileRoot = Paths.get(workspacePath);
        Path stateRoot = Paths.get(workspacePath);
        if (isSessionWorktreeMode(workspacePath, sessionName)) {
            try {
                WorktreeService worktreeService = org.noear.solon.Solon.context().getBean(WorktreeService.class);
                WorktreeStatusDTO status = worktreeService.create(ProjectRegistry.computeProjectHash(workspacePath), sessionName);
                if (!status.exists() || status.worktreePath() == null) {
                    throw new ServiceException("会话隔离分支创建失败: " + status.message());
                }
                fileRoot = Paths.get(status.worktreePath());
                log.info("[web] 会话 {} 启用隔离分支模式，工具文件根: {}", sessionName, fileRoot);
            } catch (ServiceException e) {
                throw e;
            } catch (Exception e) {
                throw new ServiceException("会话隔离分支创建失败（项目需为 Git 仓库）: " + e.getMessage());
            }
        }

        return SessionEnvironment.of(fileRoot, stateRoot);
    }

    /**
     * 获取或创建会话 Agent（创建时注入自定义系统提示词，仅首次创建生效）。
     */
    private LoopraAgent getOrCreateAgentWithPrompt(String sessionKey,
                                                   SessionStore.SessionModelSettings settings,
                                                   String systemPrompt) {
        LoopraAgent agent = sessionCache.get(sessionKey);
        if (agent != null) return getOrCreateAgent(sessionKey, settings);
        synchronized (runtimeMonitor) {
            agent = sessionCache.get(sessionKey);
            if (agent != null) return getOrCreateAgent(sessionKey, settings);
            sessionCache.evictIfNeeded();
            agent = createAgent(sessionKey, settings, systemPrompt);
            sessionCache.put(sessionKey, agent);
            log.info("[web] 创建新 Agent（自定义提示词）: {}", sessionKey);
            return agent;
        }
    }

    /**
     * 解析会话级模型设置。请求中显式传入的值优先，其次使用会话元数据，
     * 再回退到当前 Agent（兼容尚未迁移的旧会话），最后才使用全局默认值。
     */
    private SessionStore.SessionModelSettings resolveSessionModelSettings(
            String sessionKey, String requestedModel, String requestedChannelId,
            String requestedReasoningEffort) {
        String[] parts = sessionKey.split("::", 2);
        String workspacePath = parts.length > 0 ? parts[0] : null;
        String sessionName = parts.length > 1 ? parts[1] : "default";
        return resolveSessionModelSettings(
                workspacePath, sessionName, requestedModel, requestedChannelId, requestedReasoningEffort);
    }

    private SessionStore.SessionModelSettings resolveSessionModelSettings(
            String workspacePath, String sessionName, String requestedModel,
            String requestedChannelId, String requestedReasoningEffort) {
        String effectiveSessionName = sessionName == null || sessionName.isBlank() ? "default" : sessionName.trim();
        String resolvedPath = workspacePath != null ? workspacePath : getCurrentProject();
        String sessionKey = generateSessionKey(resolvedPath, effectiveSessionName);
        LoopraConfig cfg = ConfigService.getConfig();
        LoopraAgent cachedAgent = sessionCache.peek(sessionKey);
        SessionStore.SessionModelSettings cachedSettings = new SessionStore.SessionModelSettings(
                cachedAgent != null ? cachedAgent.getModel() : null,
                cachedAgent != null ? cachedAgent.getModelChannelId() : null,
                cachedAgent != null ? cachedAgent.getReasoningEffort() : null);
        return sessionSettingsService.resolve(
                resolvedPath, effectiveSessionName,
                new SessionStore.SessionModelSettings(requestedModel, requestedChannelId, requestedReasoningEffort),
                cachedSettings, cfg);
    }

    /**
     * 共享组件是否已初始化
     */
    public boolean isReady() {
        return ConfigService.getConfig() != null
                && sharedToolRegistry != null;
    }

    /**
     * 获取 Agent 整体状态（供前端状态面板使用）。
     *
     * @return 状态信息
     */
    public AgentStatusDTO getStatus() {
        boolean ready = isReady();
        String model = getSharedModel();
        String workspace = getCurrentProject();
        int cacheSize = sessionCache.size();

        int historySize = 0;
        String hitlMode = "free";
        String sessionName = null;
        long promptTokens = 0;
        long completionTokens = 0;

        // 追加默认会话的详细信息
        String defaultKey = generateSessionKey(null, null);
        LoopraAgent agent = sessionCache.get(defaultKey);
        if (agent != null) {
            historySize = agent.historySize();
            hitlMode = agent.getHitlMode();
            SessionStore store = agent.getCtx().getSessionStore();
            if (store != null) {
                sessionName = store.currentName();
            }
            long[] usage = agent.getSessionUsage();
            promptTokens = usage[0];
            completionTokens = usage[1];
        }
        return new AgentStatusDTO(ready, model, workspace, cacheSize,
                historySize, hitlMode, sessionName,
                promptTokens, completionTokens);
    }

    /**
     * 获取会话的对话历史。
     * <p>
     * 直接返回 {@code List&lt;ChatMessage&gt;}，利用 {@code @ONodeAttr} 注解
     * 控制序列化字段名（snake_case）以及排除 boolean 辅助方法，避免 Map 转换。
     * </p>
     *
     * @param workspacePath 项目路径（可选）
     * @param sessionName   会话名称（可选，不传则使用当前活跃会话）
     * @return 历史消息列表
     */
    public List<ChatMessage> getHistory(String workspacePath, String sessionName) {
        // 未指定会话名时，使用当前活跃会话
        if (sessionName == null || sessionName.isEmpty()) {
            sessionName = getCurrentSessionName(workspacePath);
        }
        if (sessionName == null) {
            return new ArrayList<>();
        }
        String sessionKey = generateSessionKey(workspacePath, sessionName);
        LoopraAgent agent = getOrCreateAgent(sessionKey);
        SessionStore store = agent.getCtx().getSessionStore();
        if (store != null) {
            try {
                store.flush();
                return store.load();
            } catch (IOException e) {
                log.warn("[web] 加载会话历史失败: {}", e.getMessage());
            }
        }
        return new ArrayList<>();
    }

    /**
     * 获取会话的原始事件日志。
     * <p>主历史在上下文压缩后只剩 checkpoint，原始消息与 tool result
     * 保留在 append-only 事件文件中，供前端审计查看与回放。</p>
     */
    public List<ChatMessage> getRawEvents(String workspacePath, String sessionName) {
        if (sessionName == null || sessionName.isEmpty()) {
            sessionName = getCurrentSessionName(workspacePath);
        }
        if (sessionName == null) {
            return new ArrayList<>();
        }
        String resolvedPath = workspacePath != null ? workspacePath : getCurrentProject();
        if (resolvedPath == null) {
            return new ArrayList<>();
        }
        try {
            Path sessionsDir = new ProjectRegistry().getSessionsDir(resolvedPath);
            if (sessionsDir == null || !Files.exists(sessionsDir)) {
                return new ArrayList<>();
            }
            SessionStore store = new JsonlSessionStore(sessionsDir);
            try {
                store.flush();
                return store.loadEvents(sessionName);
            } finally {
                store.shutdown();
            }
        } catch (IOException e) {
            log.warn("[web] 加载原始事件日志失败: {}", e.getMessage());
            return new ArrayList<>();
        }
    }

    /**
     * 向指定会话注入一条用户消息（不触发 AI 回复）。
     * <p>
     * 用于需求池评论等场景：消息通过 {@code ConversationContext.addUser} 同时进入
     * <b>Agent 上下文</b>（模型可见）并持久化到会话存储，Web 历史正常可见。
     * 注意：必须走 ctx 注入而非直接 store.append —— chat 时上下文来自内存 history，
     * 不会重新从 JSONL 加载，只写存储的消息 Agent 永远看不到。
     * </p>
     *
     * @param workspacePath 项目路径
     * @param sessionName   目标会话名称
     * @param text          消息文本
     */
    public void appendUserMessage(String workspacePath, String sessionName, String text) {
        if (sessionName == null || sessionName.isBlank() || text == null || text.isBlank()) {
            return;
        }
        String sessionKey = generateSessionKey(workspacePath, sessionName);
        LoopraAgent agent = getOrCreateAgent(sessionKey);
        if (agent.getCtx() == null) {
            return;
        }
        agent.getCtx().addUser(UserMessage.of(text)); // 进上下文 + 落盘（persist）
        SessionStore store = agent.getCtx().getSessionStore();
        if (store != null) {
            store.flush();
        }
    }

    /** 返回会话计划模式及待审查计划。 */
    public Map<String, Object> getPlanState(String workspacePath, String sessionName) {
        String effectiveSessionName = sessionName;
        if (effectiveSessionName == null || effectiveSessionName.isEmpty()) {
            effectiveSessionName = getCurrentSessionName(workspacePath);
        }
        boolean enabled = false;
        String pendingPlan = null;
        if (effectiveSessionName != null) {
            String sessionKey = generateSessionKey(workspacePath, effectiveSessionName);
            LoopraAgent agent = sessionCache.get(sessionKey);
            if (agent != null) {
                enabled = agent.isPlanMode();
                pendingPlan = agent.getPendingPlan();
            } else {
                try {
                    String resolvedPath = workspacePath != null ? workspacePath : getCurrentProject();
                    if (resolvedPath != null) {
                        Path sessionsDir = new ProjectRegistry().getSessionsDir(resolvedPath);
                        if (sessionsDir != null && Files.exists(sessionsDir)) {
                            SessionStore store = new JsonlSessionStore(sessionsDir);
                            try {
                                enabled = store.isPlanMode(effectiveSessionName);
                                pendingPlan = store.getPendingPlan(effectiveSessionName);
                            } finally {
                                store.shutdown();
                            }
                        }
                    }
                } catch (Exception e) {
                    log.warn("[web] 查询计划模式失败: {}", e.getMessage());
                }
            }
        }
        Map<String, Object> state = new LinkedHashMap<>();
        state.put("mode", enabled ? "plan" : "execute");
        state.put("pendingPlan", pendingPlan);
        return state;
    }

    public boolean getPlanMode(String workspacePath, String sessionName) {
        return "plan".equals(getPlanState(workspacePath, sessionName).get("mode"));
    }

    /** Web UI 切换会话计划模式；关闭时同时丢弃待审查计划。 */
    public Map<String, Object> setPlanMode(String workspacePath, String sessionName, boolean enabled) {
        if (sessionName == null || sessionName.isBlank()) {
            throw new ServiceException("请先选择会话");
        }
        String sessionKey = generateSessionKey(workspacePath, sessionName);
        ReentrantLock sessionLock = sessionCache.getLock(sessionKey);
        sessionLock.lock();
        try {
            LoopraAgent agent = getOrCreateAgent(sessionKey);
            if (!enabled) agent.clearPendingPlan();
            agent.setPlanMode(enabled);
            return getPlanState(workspacePath, sessionName);
        } finally {
            sessionLock.unlock();
        }
    }

    /**
     * 中断当前聊天 —— 中断所有活跃的 Agent。
     */
    public void abortCurrentChat() {
        // 中断所有缓存的 Agent
        for (LoopraAgent agent : sessionCache.values()) {
            if (agent != null) {
                agent.abort();
            }
        }
    }

    /** 中断指定项目和会话的当前生成，不影响其他并行会话。 */
    public void abortChat(String workspacePath, String sessionName) {
        String sessionKey = generateSessionKey(workspacePath, sessionName);
        LoopraAgent agent = sessionCache.get(sessionKey);
        if (agent != null) {
            agent.abort();
            log.info("[web] 已向 Agent 发送中断请求: {}", sessionKey);
            return;
        }
        // Agent 不在缓存：可能刚被 LRU 淘汰或渠道切换重建。此时若仍有任务在跑，
        // 兜底中断所有正在运行的 Agent（宁可多停，不可“停止无效”）。
        boolean anyRunning = false;
        for (String key : sessionCache.keySet()) {
            LoopraAgent cached = sessionCache.peek(key);
            if (cached != null && cached.isRunning()) {
                cached.abort();
                anyRunning = true;
            }
        }
        log.warn("[web] 停止请求未命中 Agent {}，{}", sessionKey,
                anyRunning ? "已兜底中断所有正在运行的 Agent" : "且无正在运行的 Agent（可能已结束）");
    }

    /**
     * 截断会话历史：删除包含指定撤回定位 ID 的用户消息及之后的所有消息，
     * 同时重写 JSONL 文件使持久化数据同步。
     *
     * @param workspacePath 项目路径
     * @param sessionName   会话名称
     * @param rollbackId    要截断的消息撤回定位 ID
     * @return 截断后被删除的用户消息文本（用于回填输入框），null 表示未找到
     */
    public String truncateHistoryBySnapshotId(String workspacePath, String sessionName, String rollbackId, Long rollbackTimestamp) {
        if (sessionName == null || sessionName.isEmpty()) {
            sessionName = getCurrentSessionName(workspacePath);
        }
        if (sessionName == null || (rollbackId == null && rollbackTimestamp == null)) return null;
        String sessionKey = generateSessionKey(workspacePath, sessionName);
        ReentrantLock lock = sessionCache.getLock(sessionKey);
        lock.lock();
        try {
            LoopraAgent agent = getOrCreateAgent(sessionKey);
            ConversationContext ctx = agent.getCtx();
            if (ctx == null) return null;
            List<ChatMessage> history = ctx.getHistory();
            int targetIdx = -1;
            String rollbackText = null;
            for (int i = 0; i < history.size(); i++) {
                ChatMessage msg = history.get(i);
                boolean matchesRollbackId = rollbackId != null
                        && (rollbackId.equals(msg.getRollbackId()) || rollbackId.equals(msg.getSnapshotId()));
                boolean matchesTimestamp = rollbackTimestamp != null && rollbackTimestamp.equals(msg.getTimestamp());
                if ("user".equals(msg.getRole()) && (matchesRollbackId || matchesTimestamp)) {
                    targetIdx = i;
                    rollbackText = msg.getContent();
                    break;
                }
            }
            if (targetIdx < 0) return null;
            // 任何历史截断都会使待审查计划失效，避免执行界面中已撤销的旧计划。
            agent.clearPendingPlan();
            ctx.truncate(targetIdx);
            return rollbackText;
        } finally {
            lock.unlock();
        }
    }

    // ==================== 会话管理 ====================

    /**
     * 同步聊天（多模态）—— 使用 {@link UserMessage} 统一表示文本+图片。
     */
    public String chat(UserMessage userMessage, String workspacePath, String sessionName) {
        String sessionKey = generateSessionKey(workspacePath, sessionName);
        try (SessionTurn turn = openTurn(sessionKey)) {
            LoopraAgent agent = getOrCreateAgent(sessionKey);
            turn.bind(agent, AgentOutput.NOOP);
            turn.beforeChat();
            return agent.chat(userMessage);
        }
    }

    private SessionTurn openTurn(String sessionKey) {
        String projectPath = sessionKey.split("::", 2)[0];
        return new SessionTurn(sessionCache, sessionKey, () -> applyPendingProjectMcpRefresh(projectPath));
    }

    /**
     * 流式聊天（多模态）—— 使用 {@link UserMessage} 统一表示文本+图片。
     */
    public void chatStream(UserMessage userMessage, String workspacePath, String sessionName, SseEmitter emitter,
                           String requestedModel, String requestedChannelId, String requestedReasoningEffort,
                           Boolean requestedFastMode, String action, String linkedProjectContext) {
        String sessionKey = generateSessionKey(workspacePath, sessionName);
        String effectiveSessionName = sessionName != null ? sessionName : "default";
        try (SessionTurn turn = openTurn(sessionKey)) {
            SessionStore.SessionModelSettings sessionSettings = resolveSessionModelSettings(
                    workspacePath, turn.sessionName(), requestedModel, requestedChannelId, requestedReasoningEffort);
            LoopraAgent agent = getOrCreateAgent(sessionKey, sessionSettings);
            turn.bind(agent, new SseAgentOutput(emitter));
            if (requestedFastMode != null) {
                agent.setFastMode(requestedFastMode);
            }

            String reply = turn.chat(userMessage, action, linkedProjectContext);

            // 发送最终完整回复（使用 complete 事件，与增量 content 事件区分）
            // HITL 待审批时跳过：interceptForHITL/interceptForSandboxHITL 已通过
            // output.onContentDelta() 发送过 HITL 消息，此处不应重复发送
            if (reply != null && !reply.isEmpty() && agent.noPendingHITL()) {
                agent.getCurrentTurnFileChanges().forEach(emitter::sendFileChanges);
                emitter.sendComplete(reply);
            }
        } catch (Exception e) {
            if (isUserAbortLike(e)) {
                // 用户主动停止/预期重试流程，不是故障，按 info 记录
                log.info("[chat] 聊天已停止（用户中断）: session={}, 原因: {}",
                        effectiveSessionName, e.getMessage());
            } else {
                log.error("[chat] 流式聊天执行异常: session={}, workspace={}, 原因: {}",
                        effectiveSessionName, workspacePath, e.getMessage(), e);
            }
            try {
                emitter.sendError(e.getMessage());
            } catch (Exception ex) {
                // SSE连接可能已断开，忽略异常
                log.warn("[web] 发送错误信息失败（可能SSE连接已断开）: {}", ex.getMessage());
            }
        } finally {
            try {
                emitter.complete();
            } catch (Exception ex) {
                // SSE连接可能已断开，忽略异常
                log.warn("[web] 完成SSE流失败（可能SSE连接已断开）: {}", ex.getMessage());
            }
        }
    }

    /**
     * 区分“用户主动停止/预期中断”与真实故障：中断类异常不按错误上报。
     * <p>普通聊天停止由 AgentLoop 正常返回不抛异常；计划执行（execute_plan）停止/未启动
     * 会抛 ServiceException，属于预期流程，降级为 info 日志。</p>
     */
    private static boolean isUserAbortLike(Exception e) {
        if (Thread.currentThread().isInterrupted()
                || e instanceof InterruptedException
                || e instanceof CancellationException) {
            return true;
        }
        if (e instanceof ServiceException) {
            String msg = e.getMessage();
            return msg != null && (msg.contains("已停止") || msg.contains("未能启动"));
        }
        return false;
    }

    /**
     * 创建新会话（可指定初始隔离分支模式）。
     *
     * @param workspacePath 项目路径（可选）
     * @param sessionName   会话名称（前端指定，为空则自动生成）
     * @param worktreeMode  隔离分支模式；null 表示不改变默认值（false）
     * @return 实际使用的会话名
     */
    public String newSession(String workspacePath, String sessionName, Boolean worktreeMode) {

        // 未指定会话名时自动生成
        if (sessionName == null || sessionName.isEmpty()) {
            sessionName = "loopra-" + DateTimeFormatter.ofPattern("yyyyMMddHHmmss").format(java.time.LocalDateTime.now());
        }

        // 直接以目标会话名创建/获取 Agent（switchTo 是惰性的，不创建文件）
        switchSession(workspacePath, sessionName);

        // 会话创建时固定当前有效的模型与思考强度；之后修改全局默认值只影响新会话。
        resolveSessionModelSettings(workspacePath, sessionName, null, null, null);

        // 新建会话时持久化隔离分支开关（仅在显式开启时写 .meta，避免无谓的元数据文件）
        if (Boolean.TRUE.equals(worktreeMode)) {
            setSessionWorktreeMode(workspacePath, sessionName, true);
        }

        return sessionName;
    }

    /**
     * 列出会话。
     *
     * @param workspacePath 项目路径（可选）
     * @return 会话列表
     */
    public List<SessionInfoDTO> listSessions(String workspacePath) throws IOException {
        if (!isReady()) {
            return Collections.emptyList();
        }

        // 仅读取会话目录元数据，绝不因列表查询创建 Agent：
        // 优先独立会话存储（与 Agent 会话存储同目录同格式）；
        // 仅当该会话已有缓存 Agent 时复用其存储（如隔离分支等特殊场景）。
        // 此前这里直接 getOrCreateAgent(...)，导致桌面端每次加载会话列表
        // 都会为每个项目新建 "default" 会话 Agent（每个 Agent 含 21 个插件实例），
        // 在项目之间点击切换时插件实例数只增不减。
        SessionStore store = sessionStoreFor(workspacePath);
        if (store == null) {
            String sessionKey = generateSessionKey(workspacePath, null);
            LoopraAgent agent = sessionCache.peek(sessionKey);
            if (agent != null) {
                store = agent.getCtx().getSessionStore();
            }
        }
        if (store == null) {
            return Collections.emptyList();
        }

        // 确定当前会话名（优先用追踪记录，其次用 store.currentName）
        String resolvedPath = workspacePath != null ? workspacePath : getCurrentProject();
        if (resolvedPath == null) {
            return Collections.emptyList();
        }
        String activeSession = sessionCache.getCurrentName(resolvedPath);
        if (activeSession == null) {
            activeSession = store.currentName();
        }
        List<SessionInfoDTO> sessions = new ArrayList<>();
        for (SessionStore.SessionInfo sessionInfo : store.list()) {
            String title = store.getTitle(sessionInfo.name());
            if (title == null) {
                int replicaSuffix = sessionInfo.name().lastIndexOf("[复刻]");
                if (replicaSuffix > 0) {
                    String sourceTitle = store.getTitle(sessionInfo.name().substring(0, replicaSuffix));
                    if (sourceTitle != null && !sourceTitle.isBlank()) {
                        title = sourceTitle + sessionInfo.name().substring(replicaSuffix);
                        store.updateTitle(sessionInfo.name(), title);
                    }
                }
            }
            sessions.add(new SessionInfoDTO(
                    sessionInfo.name(),
                    title,
                    sessionInfo.messageCount(),
                    sessionInfo.name().equals(activeSession),
                    sessionInfo.mtime(),
                    sessionInfo.worktreeMode()
            ));
        }
        return sessions;
    }

    /**
     * 切换会话。
     *
     * @param workspacePath 项目路径（可选）
     * @param sessionName   会话名称
     * @return 切换是否成功
     */
    public boolean switchSession(String workspacePath, String sessionName) {
        if (!isReady() || sessionName == null) {
            return false;
        }

        // 记录当前活跃会话
        String resolvedPath = workspacePath != null ? workspacePath : getCurrentProject();
        sessionCache.setCurrentName(resolvedPath, sessionName);
        return true;
    }

    /**
     * 后台触发一次 AI 自动解决隔离分支合并冲突的回合（普通 Loop turn，无需新工具）。
     * <p>AI 的文件根即隔离分支，冲突已在隔离分支内（反向合并产物），AI 用
     * git/read/edit 解冲突并提交；完成后用户再次触发合并即可快进回主项目。</p>
     *
     * @param approval 为 true 时该回合临时切到 approval HITL（ai-auto-approve）
     * @return 是否成功启动（Agent 未初始化或正在运行时返回 false）
     */
    public boolean triggerWorktreeConflictResolution(String workspacePath, String sessionName,
                                                     List<String> conflictFiles, boolean approval) {
        if (sessionName == null || sessionName.isBlank()) return false;
        String sessionKey = generateSessionKey(workspacePath, sessionName);
        LoopraAgent agent = sessionCache.peek(sessionKey);
        if (agent == null || agent.isRunning()) {
            log.warn("[worktree] 无法启动冲突解决回合: agent={}, running={}",
                    agent == null ? "null" : "cached", agent != null && agent.isRunning());
            return false;
        }
        String files = conflictFiles == null || conflictFiles.isEmpty()
                ? "（详见 git status 冲突列表）"
                : String.join("\n", conflictFiles);
        String prompt = """
                【系统任务】隔离分支合并冲突需要解决。
                当前会话的隔离分支在合并主项目分支时产生了合并冲突，冲突文件如下：
                %s
                请直接在当前文件根（隔离分支）内解决这些冲突：
                1. 用 git status / git diff 查看冲突标记与双方改动；
                2. 编辑冲突文件，保留主项目与隔离分支改动的合理结合；
                3. git add 所有已解决文件并执行 git commit 完成合并提交。
                完成后简要回复解决情况即可，用户随后会触发合并回主项目。
                """.formatted(files);
        String effectiveSessionName = sessionName;
        Thread worker = new Thread(() -> {
            ReentrantLock lock = sessionCache.getLock(sessionKey);
            lock.lock();
            try {
                LoopraAgent a = sessionCache.peek(sessionKey);
                if (a == null || a.isRunning()) return;
                a.setOutput(AgentOutput.NOOP);
                String previousHitl = null;
                if (approval) {
                    previousHitl = a.getHitlMode();
                    a.setHitlMode("approval");
                }
                try {
                    a.chat(UserMessage.of(prompt));
                } finally {
                    if (previousHitl != null) {
                        a.setHitlMode(previousHitl);
                    }
                }
            } catch (Exception e) {
                log.error("[worktree] AI 自动解决合并冲突失败: {}", e.getMessage(), e);
            } finally {
                lock.unlock();
                LoopraAgent a = sessionCache.peek(sessionKey);
                if (a != null) {
                    a.setOutput(AgentOutput.NOOP);
                    try {
                        a.flushSession();
                        a.saveUsage();
                    } catch (Exception ex) {
                        log.warn("[worktree] 冲突解决回合后刷新会话失败: {}", ex.getMessage());
                    }
                }
            }
        }, "loopra-worktree-merge-" + effectiveSessionName);
        worker.setDaemon(true);
        worker.start();
        log.info("[worktree] 已启动 AI 自动解决合并冲突回合: session={}, approval={}", sessionName, approval);
        return true;
    }

    /**
     * 获取指定会话的 Agent 缓存实例（不存在返回 null）。
     */
    public LoopraAgent peekAgent(String workspacePath, String sessionName) {
        return sessionCache.peek(generateSessionKey(workspacePath, sessionName));
    }

    // ==================== 会话级隔离分支模式 ====================

    /** 独立会话存储：仅读写主项目会话目录的元数据，不绑定任何 Agent。 */
    private SessionStore sessionStoreFor(String workspacePath) {
        String resolvedPath = workspacePath != null ? workspacePath : getCurrentProject();
        if (resolvedPath == null) return null;
        try {
            return new JsonlSessionStore(new ProjectRegistry().getSessionsDir(resolvedPath));
        } catch (Exception e) {
            log.warn("[web] 打开会话存储失败: {}", e.getMessage());
            return null;
        }
    }

    /** 获取指定会话固定使用的模型、渠道和思考强度。 */
    public SessionSettingsDTO getSessionSettings(String workspacePath, String sessionName) {
        if (sessionName == null || sessionName.isBlank()) {
            throw new ServiceException("会话名称不能为空");
        }
        SessionStore.SessionModelSettings settings = resolveSessionModelSettings(
                workspacePath, sessionName, null, null, null);
        return new SessionSettingsDTO(settings.model(), settings.modelChannelId(), settings.reasoningEffort());
    }

    /** 更新指定会话的模型、渠道和思考强度；未提供的字段保持不变。 */
    public SessionSettingsDTO updateSessionSettings(String workspacePath, String sessionName,
                                                    String model, String modelChannelId,
                                                    String reasoningEffort) {
        if (sessionName == null || sessionName.isBlank()) {
            throw new ServiceException("会话名称不能为空");
        }
        SessionStore.SessionModelSettings settings = resolveSessionModelSettings(
                workspacePath, sessionName, model, modelChannelId, reasoningEffort);
        return new SessionSettingsDTO(settings.model(), settings.modelChannelId(), settings.reasoningEffort());
    }

    /**
     * 读取指定会话的隔离分支模式开关（默认 false）。
     */
    public boolean isSessionWorktreeMode(String workspacePath, String sessionName) {
        if (sessionName == null || sessionName.isBlank()) return false;
        SessionStore store = sessionStoreFor(workspacePath);
        return store != null && store.isWorktreeMode(sessionName);
    }

    /** 静态读取隔离分支开关（供静态内部类 LRU 淘汰检查使用）。 */
    private static boolean readWorktreeModeStatic(String workspacePath, String sessionName) {
        if (workspacePath == null || sessionName == null || sessionName.isBlank()) return false;
        try {
            Path sessionsDir = new ProjectRegistry().getSessionsDir(workspacePath);
            if (sessionsDir == null || !Files.isDirectory(sessionsDir)) return false;
            SessionStore store = new JsonlSessionStore(sessionsDir);
            try {
                return store.isWorktreeMode(sessionName);
            } finally {
                store.shutdown();
            }
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 设置指定会话的隔离分支模式。
     * <p>开关影响 Agent 构造时的工具根（隔离分支 vs 主项目），因此会先淘汰缓存 Agent，
     * 下一次聊天按新开关重建。会话正在运行时不允许切换。</p>
     */
    public void setSessionWorktreeMode(String workspacePath, String sessionName, boolean enabled) {
        if (sessionName == null || sessionName.isBlank()) throw new ServiceException("会话名称不能为空");
        LoopraAgent cached = sessionCache.peek(generateSessionKey(workspacePath, sessionName));
        if (cached != null && cached.isRunning()) {
            throw new ServiceException("会话正在运行，无法切换隔离分支模式");
        }
        String resolvedPath = workspacePath != null ? workspacePath : getCurrentProject();
        SessionStore store = sessionStoreFor(resolvedPath);
        if (store == null) throw new ServiceException("会话存储不可用");
        store.setWorktreeMode(sessionName, enabled);
        if (cached != null) evictAgent(workspacePath, sessionName);
        log.info("[web] 会话隔离分支模式已切换: {} -> {}", sessionName, enabled);
    }

    /**
     * 读取指定会话的隔离分支合并模式（默认 manual）。
     */
    public String getSessionMergeMode(String workspacePath, String sessionName) {
        if (sessionName == null || sessionName.isBlank()) return "manual";
        SessionStore store = sessionStoreFor(workspacePath);
        return store != null ? store.getMergeMode(sessionName) : "manual";
    }

    /**
     * 设置指定会话的隔离分支合并模式（manual / ai-auto / ai-auto-approve）。
     */
    public void setSessionMergeMode(String workspacePath, String sessionName, String mode) {
        if (sessionName == null || sessionName.isBlank()) throw new ServiceException("会话名称不能为空");
        String normalized = mode == null ? "" : mode.trim();
        if (!normalized.isEmpty()
                && !"manual".equals(normalized)
                && !"ai-auto".equals(normalized)
                && !"ai-auto-approve".equals(normalized)) {
            throw new ServiceException("无效的合并模式: " + mode + "（可选 manual / ai-auto / ai-auto-approve）");
        }
        SessionStore store = sessionStoreFor(workspacePath);
        if (store == null) throw new ServiceException("会话存储不可用");
        store.setMergeMode(sessionName, normalized);
        log.info("[web] 会话隔离分支合并模式已切换: {} -> {}", sessionName, normalized.isEmpty() ? "manual" : normalized);
    }

    /**
     * 从指定会话分支：复制原始历史的完整前缀到新会话，并切换过去。
     *
     * @param workspacePath 项目路径
     * @param sourceSession  源会话名称
     * @param messageCount   原始历史的排他结束位置
     * @return 新会话名称
     */
    public String branchSession(String workspacePath, String sourceSession, int messageCount) throws Exception {
        if (!isReady()) throw new ServiceException("Agent 未初始化");
        String sessionKey = generateSessionKey(workspacePath, sourceSession);
        LoopraAgent agent = getOrCreateAgent(sessionKey);
        SessionStore store = agent.getCtx().getSessionStore();
        if (store == null) throw new ServiceException("会话存储不可用");

        // 加载源会话消息
        store.flush();
        List<ChatMessage> sourceMessages = store.load(sourceSession);
        List<ChatMessage> branchMessages = copyBranchMessages(sourceMessages, messageCount);
        String sourceTitle = store.getTitle(sourceSession);
        SessionStore.SessionModelSettings sourceSettings = store.getModelSettings(sourceSession);

         // 使用独立存储，让源 Agent 始终绑定到自己的会话。
        ProjectRegistry projectRegistry = new ProjectRegistry();
        Path sessionsDir = projectRegistry.getSessionsDir(workspacePath);
        JsonlSessionStore branchStore = new JsonlSessionStore(sessionsDir);
        try {
            String newName = "loopra-" + System.currentTimeMillis();
            if (!branchStore.bindTo(newName)) throw new ServiceException("无法创建新会话");
            branchStore.rewrite(branchMessages);
            branchStore.updateTitle(newName, branchTitle(sourceTitle, sourceSession));
            if (sourceSettings != null && sourceSettings.hasAnyValue()) {
                branchStore.setModelSettings(newName, sourceSettings.model(),
                        sourceSettings.modelChannelId(), sourceSettings.reasoningEffort());
            }
            branchStore.flush();

            // 切换到新会话
            switchSession(workspacePath, newName);
            return newName;
        } finally {
            branchStore.shutdown();
        }
    }

    static List<ChatMessage> copyBranchMessages(List<ChatMessage> sourceMessages, int messageCount) {
        if (sourceMessages == null || sourceMessages.isEmpty()) {
            throw new ServiceException("源会话没有消息");
        }
        if (messageCount < 1 || messageCount > sourceMessages.size()) {
            throw new ServiceException("messageCount 超出源会话消息范围");
        }
        return new ArrayList<>(sourceMessages.subList(0, messageCount));
    }

    static String branchTitle(String sourceTitle, String sourceSession) {
        String title = sourceTitle == null || sourceTitle.isBlank() ? sourceSession : sourceTitle;
        return title + "[复刻]";
    }

    /**
     * 获取当前会话名称。
     *
     * @param workspacePath 项目路径（可选）
     * @return 当前会话名称
     */
    public String getCurrentSessionName(String workspacePath) {
        // 优先从追踪记录中获取
        String resolvedPath = workspacePath != null ? workspacePath : getCurrentProject();
        String tracked = sessionCache.getCurrentName(resolvedPath);
        if (tracked != null) {
            return tracked;
        }
        // 回退到 store 查询
        String sessionKey = generateSessionKey(workspacePath, null);
        LoopraAgent agent = sessionCache.get(sessionKey);
        if (agent != null) {
            SessionStore store = agent.getCtx().getSessionStore();
            return store != null ? store.currentName() : null;
        }
        return null;
    }

    /**
     * 获取指定会话的 token 用量（返回 DTO）。
     *
     * @param workspacePath 项目路径（可选）
     * @param sessionName   会话名称（可选）
     * @return usage 数据
     */
    public UsageDTO getSessionUsageMap(String workspacePath, String sessionName) {
        String sessionKey = generateSessionKey(workspacePath, sessionName);
        LoopraAgent agent;
        // 每次按会话解析一次设置，确保模型设置 API 更新后，已缓存 Agent 的用量视图也同步。
        if (sessionName != null && !sessionName.isBlank()) {
            try {
                agent = getOrCreateAgent(sessionKey);
            } catch (RuntimeException e) {
                log.warn("[usage] 加载历史会话 '{}' 失败: {}", sessionName, e.getMessage());
                agent = sessionCache.peek(sessionKey);
            }
        } else {
            agent = sessionCache.get(sessionKey);
        }

        return sessionUsageService.read(agent);
    }

    // ==================== 工具方法 ====================

    /**
     * 获取缓存的 Agent 数量。
     *
     * @return 缓存数量
     */
    public int getCacheSize() {
        return sessionCache.size();
    }

    /**
     * 清除指定会话的 Agent 缓存。
     *
     * @param workspacePath 项目路径（可选）
     * @param sessionName   会话名称（可选）
     */
    public void evictAgent(String workspacePath, String sessionName) {
        String sessionKey = generateSessionKey(workspacePath, sessionName);
        sessionCache.dispose(sessionKey);
        log.info("[web] 已清除 Agent: {}", sessionKey);
    }

    /**
     * 重命名会话（修改显示标题）。
     * <p>会话名（文件标识）不变，仅更新 .meta 中的显示标题 title；
     * 重命名后前端会话列表展示新名称。同步置位缓存 Agent 的标题状态，
     * 避免下一轮回合开始自动生成标题覆盖用户自定义名称。</p>
     *
     * @param workspacePath 项目路径（可选）
     * @param sessionName   会话名称（文件标识，保持不变）
     * @param title         新的显示名称
     * @return 更新后的显示名称
     */
    public String renameSession(String workspacePath, String sessionName, String title) {
        if (sessionName == null || sessionName.isBlank()) {
            throw new ServiceException("会话名称不能为空");
        }
        if (title == null || title.isBlank()) {
            throw new ServiceException("新会话名称不能为空");
        }
        String normalized = title.trim();
        if (normalized.length() > 100) {
            throw new ServiceException("会话名称过长（最多 100 字符）");
        }
        String resolvedPath = workspacePath != null ? workspacePath : getCurrentProject();
        if (resolvedPath == null) {
            throw new ServiceException("未找到项目");
        }
        SessionStore store = sessionStoreFor(resolvedPath);
        if (store == null) {
            throw new ServiceException("会话存储不可用");
        }
        try {
            store.updateTitle(sessionName, normalized);
        } catch (IOException e) {
            log.warn("[web] 更新会话标题失败: {}", e.getMessage());
            throw new ServiceException("更新会话名称失败: " + e.getMessage());
        }
        // 缓存中的 Agent 同步置位标题已生成，防止自动标题覆盖自定义名称
        LoopraAgent cached = sessionCache.peek(generateSessionKey(workspacePath, sessionName));
        if (cached != null) {
            cached.markSessionTitleGenerated();
        }
        log.info("[web] 会话已重命名: {} -> {}", sessionName, normalized);
        return normalized;
    }

    /**
     * 删除指定会话：清除 Agent 缓存 + 删除磁盘文件（.jsonl / .usage / .meta）。
     *
     * @param workspacePath 项目路径（可选）
     * @param sessionName   会话名称
     */
    public void deleteSession(String workspacePath, String sessionName) {
        // 1. 清除 Agent 缓存
        evictAgent(workspacePath, sessionName);
        // 2. 删除磁盘文件
        try {
            String resolvedPath = workspacePath != null ? workspacePath : getCurrentProject();
            if (resolvedPath == null) return;
            ProjectRegistry projects = new ProjectRegistry();
            Path sessionsDir = projects.getSessionsDir(resolvedPath);
            if (sessionsDir == null || !Files.exists(sessionsDir)) return;
            SessionStore store = new JsonlSessionStore(sessionsDir);
            boolean ok = store.delete(sessionName);
            if (ok) {
                log.info("[web] 已删除会话文件: {}", sessionName);
            }
            // 级联删除该会话下挂载的子代理会话（子会话随父会话生命周期）
            SubAgentSessionStore.deleteParent(sessionsDir, sessionName);
        } catch (Exception e) {
            log.warn("[web] 删除会话文件失败: {}", e.getMessage());
        }
        // 3. 联动删除会话隔离分支（丢弃未合并改动，与会话文件删除一致）
        try {
            WorktreeService worktreeService = org.noear.solon.Solon.context().getBean(WorktreeService.class);
            worktreeService.remove(ProjectRegistry.computeProjectHash(workspacePath), sessionName, true);
        } catch (Exception e) {
            log.warn("[web] 联动删除会话隔离分支失败: {}", e.getMessage());
        }
    }

    /**
     * 清空所有会话：清除所有 Agent 缓存、删除对应隔离分支与分支，再删除所有会话磁盘文件。
     *
     * @param workspacePath 项目路径（可选）
     */
    public void clearAllSessions(String workspacePath) {
        // 1. 清除所有 Agent 缓存
        evictAllAgents();
        String resolvedPath = workspacePath != null ? workspacePath : getCurrentProject();
        if (resolvedPath == null) return;
        ProjectRegistry projects = new ProjectRegistry();
        Path sessionsDir = projects.getSessionsDir(resolvedPath);
        if (sessionsDir == null || !Files.exists(sessionsDir)) return;
        SessionStore store = new JsonlSessionStore(sessionsDir);

        // 2. 清理各会话保留的隔离分支与分支
        try {
            WorktreeService worktreeService = org.noear.solon.Solon.context().getBean(WorktreeService.class);
            String workspaceHash = ProjectRegistry.computeProjectHash(resolvedPath);
            for (SessionStore.SessionInfo session : store.list()) {
                try {
                    worktreeService.remove(workspaceHash, session.name(), true);
                } catch (Exception e) {
                    log.warn("[web] 清空会话时删除隔离分支失败 ({}): {}", session.name(), e.getMessage());
                }
            }
        } catch (Exception e) {
            log.warn("[web] 清空会话时获取隔离分支服务失败: {}", e.getMessage());
        }

        // 3. 删除所有会话磁盘文件
        store.clearAll();
        // 4. 级联清理所有子代理会话目录
        SubAgentSessionStore.deleteAll(sessionsDir);
        log.info("[web] 已清空所有会话");
    }

    /**
     * 清理最后活动时间早于指定时间点的会话（含 Agent 缓存、隔离分支与磁盘文件）。
     *
     * @param workspacePath 项目路径（可选）
     * @param beforeMillis  最后活动时间阈值（epoch 毫秒），早于该值的会话将被删除
     * @return 被删除的会话名列表
     */
    public List<String> clearSessionsBefore(String workspacePath, long beforeMillis) {
        List<String> deleted = new ArrayList<>();
        String resolvedPath = workspacePath != null ? workspacePath : getCurrentProject();
        if (resolvedPath == null) return deleted;
        ProjectRegistry projects = new ProjectRegistry();
        Path sessionsDir = projects.getSessionsDir(resolvedPath);
        if (sessionsDir == null || !Files.exists(sessionsDir)) return deleted;
        SessionStore store = new JsonlSessionStore(sessionsDir);
        try {
            for (SessionStore.SessionInfo session : store.list()) {
                if (session.mtime() < beforeMillis) {
                    deleteSession(resolvedPath, session.name());
                    deleted.add(session.name());
                }
            }
        } catch (Exception e) {
            log.warn("[web] 清理过期会话失败: {}", e.getMessage());
        }
        if (!deleted.isEmpty()) {
            log.info("[web] 已清理 {} 个过期会话: {}", deleted.size(), deleted);
        }
        return deleted;
    }

    // ==================== 兼容旧接口 ====================

    /**
     * 清除所有 Agent 缓存。
     */
    public void evictAllAgents() {
        sessionCache.clear();
        log.info("[web] 已清除所有 Agent 缓存");
    }

    @Destroy
    public void close() {
        sessionCache.clear();
    }

    private void onAgentEvicted(String sessionKey, LoopraAgent agent) {
        String[] parts = sessionKey.split("::", 2);
        if (parts.length == 2 && readWorktreeModeStatic(parts[0], parts[1])) {
            log.warn("[web] LRU 淘汰了隔离分支会话 {}，未合并改动保留在 ~/.loopra/worktree，可打开该会话合并回主项目", parts[1]);
        }
        log.info("[web] LRU 淘汰 Agent: {}", sessionKey);
    }

    /**
     * 通过项目 hash（或路径本身）反查项目路径。
     */
    public String resolveProjectPath(String hash) {
        return projectCatalog.resolveProjectPath(hash);
    }

    public String resolveProjectHashOrThrow(String projectHash) {
        if (projectHash == null || projectHash.isEmpty()) {
            throw new ServiceException("projectHash 不能为空");
        }
        String path = resolveProjectPath(projectHash);
        if (path == null) {
            throw new ServiceException("项目不存在: " + projectHash);
        }
        return path;
    }

    /**
     * 将前端选择的已注册项目解析为本轮模型上下文。这里仅注入可信路径信息；
     * 文件工具仍按原有项目边界和 HITL 策略处理跨项目访问。
     */
    public String buildLinkedProjectContext(List<String> hashes, String primaryHash) {
        return projectCatalog.buildLinkedProjectContext(hashes, primaryHash);
    }

    static String formatLinkedProjectContext(List<ProjectInfoDTO> projects) {
        return ProjectCatalog.formatLinkedProjectContext(projects);
    }

    public String getCurrentProject() {
        return projectCatalog.getCurrentProject();
    }
    public boolean switchProject(String path) {
        if (path == null || path.isEmpty()) {
            return false;
        }
        // 持久化到 config.json，下次启动默认加载此项目
        String previous = getCurrentProject();
        String normalized = Paths.get(path).toAbsolutePath().normalize().toString();
        try {
            ConfigService.updateConfig(Collections.singletonMap("workspaceDir", normalized));
            log.info("[web] 项目已持久化到 config.json: {}", normalized);
        } catch (Exception e) {
            log.warn("[web] 持久化项目到 config.json 失败: {}", e.getMessage());
        }
        // 确保项目数据目录存在（历史目录名 ~/.loopra/workspace/{hash}/）
        try {
            ProjectRegistry.getOrCreate(normalized);
            log.info("[web] 项目数据目录已创建: {}", normalized);
        } catch (Exception e) {
            log.warn("[web] 创建项目数据目录失败: {}", e.getMessage());
        }
        // 清除默认会话的缓存，让下次访问时使用新路径
        evictAgent(null, null);
        // 顺带清理旧项目的 default 会话 Agent（仅空闲时），避免桌面端跨项目点击时
        // 旧项目 Agent 永久滞留缓存；运行中的会话跳过，防止误中断正在执行的回合。
        if (previous != null && !previous.equals(normalized)) {
            LoopraAgent previousAgent = sessionCache.peek(generateSessionKey(previous, "default"));
            if (previousAgent != null && !previousAgent.isRunning()) {
                evictAgent(previous, "default");
            }
        }
        log.info("[web] 项目已切换: {}", normalized);
        return true;
    }

    public List<ProjectInfoDTO> listProjects() {
        return projectCatalog.listProjects();
    }

    /**
     * 按用户保存的顺序合并项目列表：
     * order 中的 hash 按保存顺序排列在前，未保存过排序的项目按原顺序追加到末尾，
     * order 中已不存在（被删除）的 hash 自动忽略。
     */
    public static List<ProjectInfoDTO> applyProjectOrder(List<ProjectInfoDTO> projects, List<String> order) {
        return ProjectCatalog.applyProjectOrder(projects, order);
    }

    public boolean deleteProject(String hash) {
        if (hash == null || hash.isEmpty()) {
            return false;
        }

        // 1. 查找并清除该项目的所有 Agent 缓存
        List<String> keysToRemove = new ArrayList<>();
        for (String key : sessionCache.keySet()) {
            String projectPath = key.split("::", 2)[0];
            String keyHash = ProjectRegistry.computeProjectHash(projectPath);
            if (hash.equals(keyHash)) {
                keysToRemove.add(key);
            }
        }

        for (String key : keysToRemove) {
            String[] parts = key.split("::", 2);
            String projectPath = parts[0];
            String sessionName = parts.length > 1 ? parts[1] : "default";
            evictAgent(projectPath, sessionName);
        }

        // 2. 删除项目数据目录（~/.loopra/workspace/{hash}/）
        boolean directoryDeleted = false;
        try {
            ProjectRegistry projects = new ProjectRegistry();
            directoryDeleted = projects.deleteProject(hash);
            if (directoryDeleted) {
                log.info("[web] 已删除项目数据目录: {}", hash);
            }
        } catch (Exception e) {
            log.warn("[web] 删除项目数据目录失败: {}", e.getMessage());
        }

        // 3. 如果删除的是当前项目，清除 config.json 中的 workspaceDir
        if (directoryDeleted) {
            try {
                String currentPath = getCurrentProject();
                if (currentPath != null && hash.equals(ProjectRegistry.computeProjectHash(currentPath))) {
                    ConfigService.removeConfigKey("workspaceDir");
                    log.info("[web] 已清除 config.json 中的当前项目引用: {}", currentPath);
                }
            } catch (Exception e) {
                log.warn("[web] 清除当前项目引用失败: {}", e.getMessage());
            }
        }

        log.info("[web] 已删除项目: {}，清除了 {} 个 Agent", hash, keysToRemove.size());
        return directoryDeleted;
    }

    // ==================== 定时任务与需求执行 ====================

    /** 在指定会话执行定时任务，失败说明作为任务结果返回。 */
    public String executeScheduledTask(String workspacePath, String sessionName, String message) {
        String sessionKey = generateSessionKey(workspacePath, sessionName);
        try (SessionTurn turn = openTurn(sessionKey)) {
            LoopraAgent agent = getOrCreateAgent(sessionKey);
            turn.bind(agent, AgentOutput.NOOP);
            turn.beforeChat();
            return agent.chat(UserMessage.of(message));
        } catch (Exception e) {
            log.warn("[schedule] 定时任务执行异常: session={}", sessionName, e);
            return "错误：" + e.getMessage();
        }
    }

    /**
     * 向指定会话注入一条 assistant 消息（不触发 AI 回复）。
     * <p>用于需求执行中 AI 回复用户评论（reply_requirement_comment 工具）。</p>
     */
    public void appendAssistantMessage(String workspacePath, String sessionName, String content) {
        if (sessionName == null || sessionName.isBlank() || content == null || content.isBlank()) {
            return;
        }
        String sessionKey = generateSessionKey(workspacePath, sessionName);
        LoopraAgent agent = getOrCreateAgent(sessionKey);
        SessionStore store = agent.getCtx().getSessionStore();
        if (store == null) {
            return;
        }
        ChatMessage message = new ChatMessage("assistant");
        message.setContent(content);
        message.setTimestamp(System.currentTimeMillis());
        try {
            store.append(message);
            store.flush();
        } catch (IOException e) {
            throw new ServiceException("写入会话消息失败: " + e.getMessage());
        }
    }

    /**
     * 执行需求并使用需求创建时保存的模型、推理强度和审批模式。
     */
    public String executeRequirement(String workspacePath, String sessionName, String systemPrompt, String message,
                                     boolean webHidden, String requestedModel, String requestedChannelId,
                                     String requestedReasoningEffort, String requestedHitl) {
        String sessionKey = generateSessionKey(workspacePath, sessionName);
        try (SessionTurn turn = openTurn(sessionKey)) {
            SessionStore.SessionModelSettings sessionSettings = resolveSessionModelSettings(
                    workspacePath, turn.sessionName(), requestedModel, requestedChannelId, requestedReasoningEffort);
            LoopraAgent agent = getOrCreateAgentWithPrompt(sessionKey, sessionSettings, systemPrompt);
            turn.bind(agent, AgentOutput.NOOP);
            if (requestedHitl != null && !requestedHitl.isBlank()) {
                agent.setHitlMode(requestedHitl.trim());
            }
            UserMessage userMessage = UserMessage.of(message);
            userMessage.setWebHidden(webHidden);
            turn.beforeChat();
            return agent.chat(userMessage);
        }
    }

    /**
     * 判断需求会话是否正等待人工审批。
     */
    public boolean hasPendingRequirementApproval(String workspacePath, String sessionName) {
        String sessionKey = generateSessionKey(workspacePath, sessionName);
        ReentrantLock lock = sessionCache.getLock(sessionKey);
        lock.lock();
        try {
            LoopraAgent agent = sessionCache.get(sessionKey);
            return agent != null && !agent.noPendingHITL();
        } finally {
            lock.unlock();
        }
    }

    /**
     * 对需求会话的待审批工具调用作出决定并恢复执行。
     */
    public String resolveRequirementApproval(String workspacePath, String sessionName, boolean approved) {
        String sessionKey = generateSessionKey(workspacePath, sessionName);
        try (SessionTurn turn = openTurn(sessionKey)) {
            LoopraAgent agent = sessionCache.get(sessionKey);
            if (agent == null || agent.noPendingHITL()) {
                throw new ServiceException("当前需求没有待审批的工具调用");
            }
            turn.bind(agent, AgentOutput.NOOP);
            if (approved) {
                agent.approveHITL();
            } else {
                agent.denyHITL();
            }
            turn.beforeChat();
            return agent.chat(null);
        }
    }

    // ==================== 命令与 Skill 查询 ====================

    /**
     * 获取所有命令的元数据列表（供前端命令选择弹窗使用）。
     *
     * @return 命令元数据列表
     */
    public List<CommandMetaDTO> getCommandMetaList() {
        if (commandRegistry == null) {
            return Collections.emptyList();
        }
        return commandRegistry.getCommandMetaList().stream()
                .map(m -> new CommandMetaDTO(
                        (String) m.get("cmd"),
                        (String) m.get("desc"),
                        (String) m.get("argHint")
                ))
                .collect(Collectors.toList());
    }

}
