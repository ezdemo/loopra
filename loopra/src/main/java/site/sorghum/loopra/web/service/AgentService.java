package site.sorghum.loopra.web.service;

import lombok.Getter;
import lombok.extern.slf4j.Slf4j;
import org.noear.solon.ai.talents.mount.SkillDir;
import org.noear.solon.annotation.Component;
import org.noear.solon.annotation.Init;
import org.noear.solon.annotation.Inject;
import site.sorghum.loopra.bin.agent.context.ContextTokenEstimate;
import site.sorghum.loopra.bin.agent.context.ConversationContext;
import site.sorghum.loopra.bin.agent.core.LoopraAgent;
import site.sorghum.loopra.bin.agent.environment.SessionEnvironment;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.bin.command.ChatCommandRegistry;
import site.sorghum.loopra.bin.config.ConfigService;
import site.sorghum.loopra.bin.config.LoopraConfig;
import site.sorghum.loopra.bin.mcp.McpProjectConfig;
import site.sorghum.loopra.bin.model.LoopraModelProvider;
import site.sorghum.loopra.bin.model.ModelPriceProvider;
import site.sorghum.loopra.bin.project.ProjectRegistry;
import site.sorghum.loopra.bin.session.JsonlSessionStore;
import site.sorghum.loopra.bin.session.SessionFileChangeTracker;
import site.sorghum.loopra.bin.session.SessionStore;
import site.sorghum.loopra.bin.session.SubAgentSessionStore;
import site.sorghum.loopra.bin.tool.ToolRegistry;
import site.sorghum.loopra.bin.tool.ToolSystemInitializer;
import site.sorghum.loopra.tool.AgentOutput;
import site.sorghum.loopra.tool.solon.common.SessionTerminalTalent;
import site.sorghum.loopra.tool.solon.common.SessionTerminalTalent.BashSessionInfo;
import site.sorghum.loopra.tool.solon.common.LoopraSkillProvider;
import site.sorghum.loopra.tool.solon.mcp.ProjectMcpSkill;
import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.common.UsageCostCalculator;
import site.sorghum.loopra.web.model.*;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;
import java.util.stream.Collectors;

/**
 * Agent 会话级服务 —— 管理 LoopraAgent 的生命周期和并发访问。
 * <p>
 * 实现"一个会话一个 Agent"架构：
 * - 每个会话（workspacePath::sessionName）拥有独立的 LoopraAgent 实例
 * - 共享 LoopraModelProvider、ToolRegistry 减少资源消耗
 * - 每个 Agent 有自己的 ReentrantLock，支持并发聊天
 * - 使用 LRU 缓存策略管理 Agent 实例数量
 * @author Sorghum
 */
@Slf4j
@Component
public class AgentService {

    /**
     * 最大缓存 Agent 数量
     */
    private static final int MAX_CACHE_SIZE = 50;
    /**
     * 当前线程正在处理的会话名称（用于工具执行时获取 sessionId）
     */
    private static final ThreadLocal<String> CURRENT_SESSION_NAME = new ThreadLocal<>();

    /**
     * 会话级 Agent 缓存（LRU 淘汰策略）。
     * <p>
     * 封装 agents、order、locks、currentNames 四个内部结构，
     * 对外提供统一的 get/put/evict/clear/lock 操作。
     * </p>
     */
    private static class SessionAgentCache {
        private final ConcurrentHashMap<String, LoopraAgent> agents = new ConcurrentHashMap<>();
        private final ConcurrentHashMap<String, ReentrantLock> locks = new ConcurrentHashMap<>();
        private final ConcurrentHashMap<String, String> currentNames = new ConcurrentHashMap<>();
        /** LRU 访问顺序跟踪（synchronized 保证 put/get 与 evict 的原子性） */
        private final List<String> accessOrder = Collections.synchronizedList(new LinkedList<>());

        LoopraAgent get(String key) {
            // 先查 agents（ConcurrentHashMap 无锁读），再更新 LRU 顺序
            LoopraAgent agent = agents.get(key);
            if (agent != null) {
                synchronized (accessOrder) {
                    accessOrder.remove(key);
                    accessOrder.add(0, key);
                }
            }
            return agent;
        }

        /** 不改变 LRU 顺序地读取缓存中的 Agent。 */
        LoopraAgent peek(String key) {
            return agents.get(key);
        }

        void put(String key, LoopraAgent agent) {
            agents.put(key, agent);
            synchronized (accessOrder) {
                accessOrder.remove(key);
                accessOrder.add(0, key);
            }
        }

        void evictIfNeeded() {
            while (agents.size() >= MAX_CACHE_SIZE) {
                String oldest;
                synchronized (accessOrder) {
                    if (accessOrder.isEmpty()) break;
                    // 从最久未访问开始淘汰，跳过仍在运行的 Agent（运行中无法安全中断，
                    // 一旦淘汰，前端停止请求将永远无法命中它 → 表现为“停止无效”）
                    oldest = null;
                    for (int i = accessOrder.size() - 1; i >= 0; i--) {
                        String candidate = accessOrder.get(i);
                        LoopraAgent candidateAgent = agents.get(candidate);
                        if (candidateAgent == null || !candidateAgent.isRunning()) {
                            oldest = candidate;
                            accessOrder.remove(i);
                            break;
                        }
                    }
                    if (oldest == null) break; // 全部正在运行，暂不淘汰（允许短暂超出容量上限）
                }
                if (oldest != null) {
                    LoopraAgent removed = agents.remove(oldest);
                    if (removed != null) {
                        try {
                            removed.dispose();
                        } catch (Exception e) {
                            log.info("[web] 淘汰 Agent 失败: {}", e.getMessage());
                        }
                        // 隔离分支会话被淘汰：隔离分支保留在磁盘，提醒可通过会话合并按钮回收
                        try {
                            String[] keyParts = oldest.split("::", 2);
                            if (keyParts.length == 2 && readWorktreeModeStatic(keyParts[0], keyParts[1])) {
                                log.warn("[web] LRU 淘汰了隔离分支会话 {}，未合并改动保留在 ~/.loopra/worktree，可打开该会话合并回主项目", keyParts[1]);
                            }
                        } catch (Exception e) {
                            log.debug("[web] 检查隔离分支状态失败: {}", e.getMessage());
                        }
                        log.info("[web] LRU 淘汰 Agent: {}", oldest);
                    }
                }
            }
        }

        void clear() {
            agents.clear();
            accessOrder.clear();
            locks.clear();
            currentNames.clear();
        }

        LoopraAgent remove(String key) {
            accessOrder.remove(key);
            locks.remove(key);
            return agents.remove(key);
        }

        Set<String> keySet() {
            return agents.keySet();
        }

        Set<Map.Entry<String, LoopraAgent>> entrySet() {
            return agents.entrySet();
        }

        ReentrantLock getLock(String key) {
            return locks.computeIfAbsent(key, k -> new ReentrantLock());
        }

        String getCurrentName(String workspacePath) {
            return currentNames.get(workspacePath);
        }

        void setCurrentName(String workspacePath, String sessionName) {
            currentNames.put(workspacePath, sessionName);
        }

        Collection<LoopraAgent> values() {
            return agents.values();
        }

        int size() {
            return agents.size();
        }
    }

    @Inject
    ChatCommandRegistry commandRegistry;

    @Inject
    private ConfigService configService;

    /**
     * 会话级 Agent 缓存
     */
    private final SessionAgentCache sessionCache = new SessionAgentCache();

    /** 会话模型设置的读取、解析与持久化。 */
    private final SessionSettingsService sessionSettingsService =
            new SessionSettingsService(this::sessionStoreFor);

    /**
     * 默认项目的共享 ToolRegistry（供 /api/tools 等接口与就绪检查使用）
     */
    @Getter
    private volatile ToolRegistry sharedToolRegistry;

    /**
     * 按项目缓存的工具系统初始化结果（绝对路径 -> Result）。
     * <p>同一项目的所有会话 Agent 复用其 ToolRegistry 与 PromptPrefix，
     * 避免每个 Agent 重复扫描工具/构建提示词；配置重建（{@link #reinitialize()}）时清空。</p>
     */
    private final ConcurrentHashMap<String, ToolSystemInitializer.ToolSystem> sharedToolSystems = new ConcurrentHashMap<>();

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
     * 计算项目路径的 hash 值（MD5 前 12 位）。
     */
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
    public synchronized void reinitialize() {
        log.info("[config] 开始重新初始化 AgentService...");

        // 1. 先 dispose 所有缓存的 Agent（注销监听 + 刷入数据）
        for (LoopraAgent agent : sessionCache.values()) {
            try {
                agent.dispose();
            } catch (Exception e) {
                log.warn("[config] dispose Agent 时异常: {}", e.getMessage());
            }
        }

        // 2. 清空所有缓存
        sessionCache.clear();
        sharedToolSystems.clear();

        // 3. 重新加载配置并构建共享组件
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
     * 根据配置构建所有共享组件（LoopraModelProvider、ToolRegistry 等）。
     * <p>
     * 抽取自 {@link #init()} 和 {@link #reinitialize()} 中的重复逻辑，
     * 单一职责：加载配置并初始化共享字段，不含缓存清理等上下文操作。
     * </p>
     *
     * @param config 已加载的 Loopra 配置
     * @return true 表示初始化成功，false 表示缺少必要的 API Key
     */
    private boolean buildSharedComponents(LoopraConfig config) {
        String apiUrl = config.apiUrl();
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
        sharedToolSystems.put(workspaceKey(config.workspaceDir()), initResult);
        this.sharedToolRegistry = initResult.toolRegistry();

        return true;
    }

    private ToolSystemInitializer.ToolSystem getOrCreateSharedToolSystem(SessionEnvironment environment) {
        String key = environment == null ? "" : environmentKey(environment);
        return sharedToolSystems.computeIfAbsent(key,
                k -> ToolSystemInitializer.initialize(
                        environment,
                        ConfigService.getConfig().disabledTools(),
                        loadDefaultSystemPrompt()));
    }

    private static String environmentKey(SessionEnvironment environment) {
        return workspaceKey(environment.projectRoot())
                + "#" + workspaceKey(environment.executionRoot())
                + "#" + workspaceKey(environment.stateRoot());
    }

    private static String workspaceKey(Path workspace) {
        // 未配置项目时返回空键（initialize 本身容忍 null 项目）
        return workspace == null ? "" : workspace.toAbsolutePath().normalize().toString();
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

    /**
     * 当前正在处理的会话任务登记。
     * <p>
     * AgentLoop 的运行标志覆盖已经进入推理循环的任务；这里额外登记 Web 请求，
     * 覆盖流任务在线程池中等待或尚未创建 Agent 的窗口。
     * </p>
     */
    private final ConcurrentHashMap<String, Set<String>> activeSessionTasks = new ConcurrentHashMap<>();

    /**
     * 由 {@code mcprefresh} 工具登记、等待当前项目所有会话空闲后执行的 MCP 刷新。
     * 键为规范化后的项目根目录字符串。
     */
    private final Set<String> pendingProjectMcpRefreshes = ConcurrentHashMap.newKeySet();

    /**
     * 登记一个会话级后台任务。
     *
     * @param workspacePath 项目路径
     * @param sessionName   会话名称
     * @param requestId     请求/任务唯一 ID
     */
    public void registerSessionTask(String workspacePath, String sessionName, String requestId) {
        if (requestId == null || requestId.isBlank()) return;
        String sessionKey = generateSessionKey(workspacePath, sessionName);
        activeSessionTasks.computeIfAbsent(sessionKey, key -> ConcurrentHashMap.newKeySet()).add(requestId);
    }

    /** 移除指定会话任务登记；不会误删同一会话随后登记的任务。 */
    public void unregisterSessionTask(String workspacePath, String sessionName, String requestId) {
        if (requestId == null || requestId.isBlank()) return;
        String sessionKey = generateSessionKey(workspacePath, sessionName);
        Set<String> tasks = activeSessionTasks.get(sessionKey);
        if (tasks == null) return;
        tasks.remove(requestId);
        if (tasks.isEmpty()) activeSessionTasks.remove(sessionKey, tasks);
        applyPendingProjectMcpRefresh(workspacePath);
    }

    /**
     * 获取指定项目/会话的运行状态。
     * <p>状态只来自活动任务登记或缓存 Agent 的实际运行标志，不根据历史消息变化推断。</p>
     */
    public SessionStatusDTO getSessionStatus(String workspacePath, String sessionName) {
        String sessionKey = generateSessionKey(workspacePath, sessionName);
        Set<String> tasks = activeSessionTasks.get(sessionKey);
        String requestId = tasks == null ? null : tasks.stream().findFirst().orElse(null);
        LoopraAgent agent = sessionCache.peek(sessionKey);
        boolean running = (tasks != null && !tasks.isEmpty()) || (agent != null && agent.isRunning());
        return new SessionStatusDTO(running, requestId);
    }

    /**
     * 获取当前项目会话可见的项目 Skill 与项目级 MCP 摘要。
     *
     * <p>该接口复用项目工具提供者，因此面板展示的 MCP 与实际会话加载的 MCP
     * 来自同一份项目级运行时；Skill 仅返回项目目录下的项目 Skill，响应只包含名称、状态和工具名，
     * 不返回连接密钥等配置。</p>
     */
    public ProjectCapabilitiesDTO getProjectCapabilities(String workspacePath) {
        if (workspacePath == null || workspacePath.isBlank()) {
            return new ProjectCapabilitiesDTO(null, null, false, null, false,
                    List.of(), List.of());
        }

        Path projectRoot = Paths.get(workspacePath).toAbsolutePath().normalize();
        LoopraSkillProvider provider = LoopraSkillProvider.getOrCreate(projectRoot.toString());
        provider.getPoolManager().refresh();

        Path projectSkillsPath = projectRoot.resolve(".loopra").resolve("skills");
        List<ProjectSkillMetaDTO> skills = provider.getPoolManager().getSkills().stream()
                .filter(Objects::nonNull)
                .filter(skill -> "@project-skills".equals(skill.getMountAlias()))
                .sorted(Comparator.comparing(SkillDir::getName,
                        Comparator.nullsLast(String.CASE_INSENSITIVE_ORDER)))
                .map(skill -> new ProjectSkillMetaDTO(
                        skill.getName(),
                        skill.getDescription(),
                        "project",
                        skill.getMountAlias(),
                        skill.getRealPath() == null ? null : skill.getRealPath().toString()))
                .toList();

        ProjectMcpSkill projectMcpSkill = provider.getProjectMcpSkill();
        List<ProjectMcpServerDTO> mcpServers = projectMcpSkill == null
                ? List.of()
                : projectMcpSkill.serverInfos().stream()
                .map(server -> new ProjectMcpServerDTO(
                        server.name(),
                        server.type(),
                        server.enabled(),
                        server.loaded(),
                        server.toolCount(),
                        server.toolNames(),
                        server.error() == null ? null : "加载失败"))
                .toList();

        Path mcpConfigPath = McpProjectConfig.path(projectRoot);
        return new ProjectCapabilitiesDTO(
                projectRoot.toString(),
                mcpConfigPath == null ? null : mcpConfigPath.toString(),
                mcpConfigPath != null && Files.isRegularFile(mcpConfigPath),
                projectSkillsPath.toString(),
                Files.isDirectory(projectSkillsPath),
                skills,
                mcpServers);
    }

    /**
     * 由 Agent 内的 {@code mcprefresh} 调用：登记当前项目的 MCP 刷新。
     *
     * <p>工具调用本身运行在 Agent 循环中，不能在此刻关闭它正持有的 MCP 客户端；
     * 因此刷新会在该项目全部会话空闲后自动完成，并在下一条消息生效。</p>
     */
    public String requestProjectMcpRefresh(String workspacePath) {
        Path projectRoot = normalizeProjectRoot(workspacePath);
        if (projectRoot == null) {
            return "WORKSPACE_MISSING: 无法确定当前项目，不能刷新 MCP";
        }
        pendingProjectMcpRefreshes.add(projectRoot.toString());
        return "项目 MCP 刷新已登记。本轮对话完成后会重新读取 .loopra/mcp-servers.json 并重建连接；下一条消息即可使用最新 MCP。";
    }

    /**
     * 重新加载指定项目的项目级 Skill/MCP。
     *
     * <p>项目 MCP 会被绑定到工具扫描提供者和会话 Agent 的共享工具系统中，
     * 因此仅重新读取面板摘要不足以让新增或删除的服务器进入下一轮对话。
     * 这里回收该项目的空闲 Agent、共享工具系统和项目 MCP provider，下一次聊天
     * 请求会按磁盘上的最新配置重新创建它们。正在运行的会话不在这里被强制中断。</p>
     */
    public synchronized ProjectCapabilitiesDTO refreshProjectCapabilities(String workspacePath) {
        if (workspacePath == null || workspacePath.isBlank()) {
            throw new ServiceException("项目路径不能为空");
        }

        Path projectRoot = normalizeProjectRoot(workspacePath);
        if (projectRoot == null) {
            throw new ServiceException("项目路径无效");
        }
        Set<String> projectProviderRoots = new LinkedHashSet<>();
        projectProviderRoots.add(projectRoot.toString());

        // 先做完整检查；如果有活动任务，不要只回收其中一部分 Agent。
        List<String> busySessions = new ArrayList<>();
        for (Map.Entry<String, Set<String>> entry : activeSessionTasks.entrySet()) {
            if (belongsToProject(entry.getKey(), projectRoot)
                    && entry.getValue() != null && !entry.getValue().isEmpty()) {
                busySessions.add(entry.getKey());
            }
        }
        for (String sessionKey : sessionCache.keySet()) {
            if (!belongsToProject(sessionKey, projectRoot)) continue;
            LoopraAgent agent = sessionCache.peek(sessionKey);
            if (agent != null && agent.isRunning()) {
                busySessions.add(sessionKey);
            }
        }
        if (!busySessions.isEmpty()) {
            throw new ServiceException("当前项目有会话正在运行，请先停止后再刷新 MCP");
        }

        // 释放空闲 Agent 使用的 cutin 工具注册和会话资源，避免继续引用旧的 MCP 工具。
        for (String sessionKey : new ArrayList<>(sessionCache.keySet())) {
            if (!belongsToProject(sessionKey, projectRoot)) continue;
            LoopraAgent agent = sessionCache.remove(sessionKey);
            if (agent == null) continue;
            if (agent.getEnvironment() != null) {
                Path executionRoot = agent.getEnvironment().executionRoot();
                if (executionRoot != null) {
                    projectProviderRoots.add(executionRoot.toAbsolutePath().normalize().toString());
                }
            }
            try {
                agent.dispose();
            } catch (Exception e) {
                log.warn("[mcp-project] 刷新项目能力时释放 Agent 失败: {} - {}", sessionKey, e.getMessage());
            }
        }

        // 默认工具管理接口复用这份 registry；清空后下一次 refresh 会重新扫描。
        LoopraConfig config = ConfigService.getConfig();
        Path defaultProject = config == null ? null : config.workspaceDir();
        if (defaultProject != null
                && projectRoot.equals(defaultProject.toAbsolutePath().normalize())
                && sharedToolRegistry != null) {
            sharedToolRegistry.clearTools();
        }

        String projectKey = projectRoot.toString();
        sharedToolSystems.keySet().removeIf(key -> key.equals(projectKey) || key.startsWith(projectKey + "#"));
        for (String providerRoot : projectProviderRoots) {
            LoopraSkillProvider.removeFor(providerRoot);
        }

        log.info("[mcp-project] 已刷新项目能力: {}，下次聊天将使用最新配置", projectRoot);
        ProjectCapabilitiesDTO capabilities = getProjectCapabilities(projectRoot.toString());
        pendingProjectMcpRefreshes.remove(projectKey);
        return capabilities;
    }

    /** 在会话任务结束后尝试执行工具登记的项目 MCP 刷新；仍有并发会话时保留登记等待下次触发。 */
    private void applyPendingProjectMcpRefresh(String workspacePath) {
        Path projectRoot = normalizeProjectRoot(workspacePath);
        if (projectRoot == null || !pendingProjectMcpRefreshes.contains(projectRoot.toString())) {
            return;
        }
        try {
            refreshProjectCapabilities(projectRoot.toString());
        } catch (ServiceException e) {
            // 当前项目还有别的会话在运行；最后一个结束的会话会再次触发本方法。
            if (hasRunningProjectSession(projectRoot)) {
                log.debug("[mcp-project] 等待项目会话结束后刷新 MCP: {}", projectRoot);
                return;
            }
            pendingProjectMcpRefreshes.remove(projectRoot.toString());
            log.warn("[mcp-project] 自动刷新项目 MCP 失败: {} - {}", projectRoot, e.getMessage());
        } catch (Exception e) {
            pendingProjectMcpRefreshes.remove(projectRoot.toString());
            log.warn("[mcp-project] 自动刷新项目 MCP 失败: {} - {}", projectRoot, e.getMessage());
        }
    }

    private boolean hasRunningProjectSession(Path projectRoot) {
        for (Map.Entry<String, Set<String>> entry : activeSessionTasks.entrySet()) {
            if (belongsToProject(entry.getKey(), projectRoot)
                    && entry.getValue() != null && !entry.getValue().isEmpty()) {
                return true;
            }
        }
        for (String sessionKey : sessionCache.keySet()) {
            if (!belongsToProject(sessionKey, projectRoot)) continue;
            LoopraAgent agent = sessionCache.peek(sessionKey);
            if (agent != null && agent.isRunning()) {
                return true;
            }
        }
        return false;
    }

    private static Path normalizeProjectRoot(String workspacePath) {
        if (workspacePath == null || workspacePath.isBlank()) return null;
        try {
            return Paths.get(workspacePath).toAbsolutePath().normalize();
        } catch (RuntimeException ignored) {
            return null;
        }
    }

    private static boolean belongsToProject(String sessionKey, Path projectRoot) {
        if (sessionKey == null || projectRoot == null) return false;
        int separator = sessionKey.indexOf("::");
        if (separator <= 0) return false;
        try {
            Path sessionRoot = Paths.get(sessionKey.substring(0, separator))
                    .toAbsolutePath().normalize();
            return projectRoot.equals(sessionRoot);
        } catch (RuntimeException ignored) {
            return false;
        }
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
        ModelTarget target = targetOf(settings);
        // 更新访问顺序并检查缓存
        LoopraAgent agent = sessionCache.get(sessionKey);
        if (agent != null) {
            ModelTarget currentTarget = new ModelTarget(agent.getModel(), agent.getModelChannelId());
            if (target.equals(currentTarget)) {
                agent.setReasoningEffort(settings.reasoningEffort());
                return agent;
            }
            if (currentTarget != null && currentTarget.channelId().equals(target.channelId())) {
                agent.setModel(target.model());
                agent.setMaxTokens(ConfigService.getConfig().modelMaxTokens(target.channelId(), target.model()));
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
            agent.dispose();
            agent = createAgent(sessionKey, settings, null);
            sessionCache.put(sessionKey, agent);
            log.info("[web] 会话模型渠道已切换: {}, {}/{}", sessionKey, target.channelId(), target.model());
            return agent;
        }

        // 创建新 Agent
        synchronized (this) {
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
        ModelTarget target = targetOf(settings);
        String[] parts = sessionKey.split("::", 2);
        String workspacePath = parts[0];
        String sessionName = parts.length > 1 ? parts[1] : "default";
        LoopraConfig cfg = ConfigService.getConfig();
        LoopraConfig.ModelChannel channel = cfg.modelChannel(target.channelId());
        if (channel == null) throw new ServiceException("模型渠道不存在: " + target.channelId());

        String apiUrl = channel.apiUrl();
        String apiKey = channel.apiKey();
        String reasoningEffort = settings.reasoningEffort();
        String hitl = cfg.hitl();
        LoopraModelProvider modelProvider = new LoopraModelProvider(apiUrl, apiKey, target.model(), reasoningEffort,
                target.channelId(), channel.apiProtocol(), channel.specialCompatibility(),
                cfg.modelMaxTokens(target.channelId(), target.model()));
        modelProvider.setFastMode(cfg.fastMode());

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

        LoopraAgent.Builder builder = LoopraAgent.builder()
                .config(cfg)
                .environment(SessionEnvironment.of(fileRoot, stateRoot))
                .commandRegistry(commandRegistry)
                .hitl(hitl)
                // 复用该项目的共享工具系统，跳过 Agent 内部的重复初始化
                .toolSystem(getOrCreateSharedToolSystem(SessionEnvironment.of(fileRoot, stateRoot)))
                .modelProvider(modelProvider);
        if (systemPrompt != null && !systemPrompt.isBlank()) {
            builder.systemPrompt(systemPrompt);
        }
        LoopraAgent agent = builder.buildLightweight();
        agent.bindSession(sessionName);
        agent.setListener(new WebUsageListener(agent));
        agent.setOutput(AgentOutput.NOOP);
        return agent;
    }

    /**
     * 获取或创建会话 Agent（创建时注入自定义系统提示词，仅首次创建生效）。
     */
    private LoopraAgent getOrCreateAgentWithPrompt(String sessionKey,
                                                   SessionStore.SessionModelSettings settings,
                                                   String systemPrompt) {
        LoopraAgent agent = sessionCache.get(sessionKey);
        if (agent != null) return getOrCreateAgent(sessionKey, settings);
        synchronized (this) {
            agent = sessionCache.get(sessionKey);
            if (agent != null) return getOrCreateAgent(sessionKey, settings);
            sessionCache.evictIfNeeded();
            agent = createAgent(sessionKey, settings, systemPrompt);
            sessionCache.put(sessionKey, agent);
            log.info("[web] 创建新 Agent（自定义提示词）: {}", sessionKey);
            return agent;
        }
    }

    private ModelTarget defaultModelTarget() {
        LoopraConfig cfg = ConfigService.getConfig();
        LoopraConfig.ModelChannel channel = cfg.activeModelChannel();
        return new ModelTarget(cfg.model(), channel != null ? channel.id() : "default");
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
        ModelTarget globalTarget = defaultModelTarget();
        LoopraAgent cachedAgent = sessionCache.peek(sessionKey);
        SessionStore.SessionModelSettings cachedSettings = new SessionStore.SessionModelSettings(
                cachedAgent != null ? cachedAgent.getModel() : null,
                cachedAgent != null ? cachedAgent.getModelChannelId() : null,
                cachedAgent != null ? cachedAgent.getReasoningEffort() : null);
        return sessionSettingsService.resolve(
                resolvedPath, effectiveSessionName,
                new SessionStore.SessionModelSettings(requestedModel, requestedChannelId, requestedReasoningEffort),
                cachedSettings, globalTarget.model(), globalTarget.channelId(), cfg.reasoningEffort(), cfg);
    }

    private static ModelTarget targetOf(SessionStore.SessionModelSettings settings) {
        return new ModelTarget(settings.model(), settings.modelChannelId());
    }

    private record ModelTarget(String model, String channelId) {}

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
        ReentrantLock lock = sessionCache.getLock(sessionKey);
        lock.lock();
        long turnStartedAt = System.currentTimeMillis();
        int historySizeBeforeChat = -1;

        // 设置当前会话名称到 ThreadLocal，供工具执行时获取
        String effectiveSessionName = sessionName != null ? sessionName : "default";
        SessionFileChangeTracker.beginTurn(Paths.get(workspacePath), effectiveSessionName);
        CURRENT_SESSION_NAME.set(effectiveSessionName);
        LoopraModelProvider.CURRENT_LOG_SESSION.set(effectiveSessionName);

        try {
            LoopraAgent agent = getOrCreateAgent(sessionKey);

            agent.setOutput(AgentOutput.NOOP);
            // 设置会话ID到 AgentLoop
            String sessionId = sessionName != null ? sessionName : "default";
            agent.setSessionId(sessionId);
            historySizeBeforeChat = agent.historySize();
            return agent.chat(userMessage);
        } finally {
            // 清理 ThreadLocal
            CURRENT_SESSION_NAME.remove();
            LoopraModelProvider.CURRENT_LOG_SESSION.remove();
            // 刷入会话数据
            LoopraAgent agent = sessionCache.get(sessionKey);
            if (agent != null) {
                persistTurnTiming(agent, historySizeBeforeChat, turnStartedAt, System.currentTimeMillis());
                agent.flushSession();
                agent.saveUsage();
            }
            lock.unlock();
            // 同步调用没有 Web 任务登记；在会话锁释放后处理 mcprefresh 的延迟重载。
            applyPendingProjectMcpRefresh(workspacePath);
        }
    }

    /**
     * 流式聊天（多模态）—— 使用 {@link UserMessage} 统一表示文本+图片。
     */
    public void chatStream(UserMessage userMessage, String workspacePath, String sessionName, SseEmitter emitter,
                           String requestedModel, String requestedChannelId, String requestedReasoningEffort,
                           Boolean requestedFastMode, String action, String linkedProjectContext) {
        String sessionKey = generateSessionKey(workspacePath, sessionName);
        ReentrantLock lock = sessionCache.getLock(sessionKey);
        lock.lock();
        long turnStartedAt = System.currentTimeMillis();
        int historySizeBeforeChat = -1;

        // 设置当前会话名称到 ThreadLocal，供工具执行时获取
        String effectiveSessionName = sessionName != null ? sessionName : "default";
        SessionFileChangeTracker.beginTurn(Paths.get(workspacePath), effectiveSessionName);
        CURRENT_SESSION_NAME.set(effectiveSessionName);
        LoopraModelProvider.CURRENT_LOG_SESSION.set(effectiveSessionName);

        try {
            SessionStore.SessionModelSettings sessionSettings = resolveSessionModelSettings(
                    workspacePath, effectiveSessionName, requestedModel, requestedChannelId, requestedReasoningEffort);
            LoopraAgent agent = getOrCreateAgent(sessionKey, sessionSettings);
            if (requestedFastMode != null) {
                agent.setFastMode(requestedFastMode);
            }

            // 设置 AgentOutput：将所有事件桥接到 SSE
            agent.setOutput(new SseAgentOutput(emitter));

            UserMessage effectiveMessage = userMessage;
            boolean planExecutionPrepared = false;
            int historySizeBeforeExecution = agent.historySize();
            if (action != null && !action.isBlank()) {
                if (!"execute_plan".equals(action)) {
                    throw new ServiceException("不支持的聊天操作: " + action);
                }
                String executionMessage = agent.preparePendingPlanExecution();
                if (executionMessage == null) {
                    throw new ServiceException("当前会话没有待审查计划");
                }
                planExecutionPrepared = true;
                effectiveMessage = UserMessage.of(executionMessage);
                effectiveMessage.setWebHidden(true);
                if (userMessage != null) {
                    effectiveMessage.setRollbackId(userMessage.getRollbackId());
                    effectiveMessage.setSnapshotId(userMessage.getSnapshotId());
                }
            }

            String reply;
            try {
                if (linkedProjectContext != null && !linkedProjectContext.isBlank()) {
                    UserMessage contextMessage = UserMessage.of(linkedProjectContext);
                    contextMessage.setWebHidden(true);
                    agent.getCtx().addUser(contextMessage);
                }
                historySizeBeforeChat = agent.historySize();
                reply = agent.chat(effectiveMessage);
            } catch (Exception executionError) {
                if (planExecutionPrepared) {
                    if (!hasPlanExecutionStarted(agent)) {
                        agent.getCtx().truncate(historySizeBeforeExecution);
                        agent.restorePendingPlanExecution();
                    } else {
                        agent.clearPendingPlan();
                    }
                }
                throw executionError;
            }
            if (planExecutionPrepared) {
                if (agent.isAbortRequested()) {
                    if (!hasPlanExecutionStarted(agent)) {
                        agent.getCtx().truncate(historySizeBeforeExecution);
                        agent.restorePendingPlanExecution();
                    } else {
                        agent.clearPendingPlan();
                    }
                    throw new ServiceException("计划执行已停止");
                }
                if (!hasPlanExecutionStarted(agent)) {
                    agent.getCtx().truncate(historySizeBeforeExecution);
                    agent.restorePendingPlanExecution();
                    throw new ServiceException("计划执行未能启动，请重试");
                }
                agent.clearPendingPlan();
            }

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
            // 清理 ThreadLocal
            CURRENT_SESSION_NAME.remove();
            LoopraModelProvider.CURRENT_LOG_SESSION.remove();
            // 恢复 Agent 输出
            LoopraAgent agent = sessionCache.get(sessionKey);
            if (agent != null) {
                agent.setOutput(AgentOutput.NOOP);
                persistTurnTiming(agent, historySizeBeforeChat, turnStartedAt, System.currentTimeMillis());
                agent.flushSession();
                agent.saveUsage();
            }

            try {
                emitter.complete();
            } catch (Exception ex) {
                // SSE连接可能已断开，忽略异常
                log.warn("[web] 完成SSE流失败（可能SSE连接已断开）: {}", ex.getMessage());
            }

            lock.unlock();
        }
    }

    /**
     * 为本轮生成的 assistant 消息写入整轮耗时。
     *
     * <p>消息在 AgentLoop 中是逐条 append 的，回合结束后才知道完整耗时，
     * 因此这里更新内存对象并重写当前会话文件；事件审计日志仍保持 append-only。</p>
     */
    private void persistTurnTiming(LoopraAgent agent, int historyStart,
                                   long startedAt, long finishedAt) {
        if (agent == null || historyStart < 0 || finishedAt < startedAt) return;
        ConversationContext ctx = agent.getCtx();
        if (ctx == null) return;
        List<ChatMessage> history = ctx.getHistory();
        if (historyStart >= history.size()) return;

        long elapsedMs = Math.max(0L, finishedAt - startedAt);
        boolean updated = false;
        for (int i = historyStart; i < history.size(); i++) {
            ChatMessage message = history.get(i);
            if (!message.isAssistant()) continue;
            message.setTurnStartedAt(startedAt);
            message.setTurnFinishedAt(finishedAt);
            message.setElapsedMs(elapsedMs);
            updated = true;
        }
        if (!updated || ctx.getSessionStore() == null) return;
        try {
            ctx.getSessionStore().rewrite(history);
        } catch (IOException e) {
            log.warn("[session] 写入助手回合耗时失败: {}", e.getMessage());
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

    private boolean hasPlanExecutionStarted(LoopraAgent agent) {
        List<ChatMessage> history = agent.getCtx().getHistory();
        int hiddenInstruction = -1;
        for (int i = history.size() - 1; i >= 0; i--) {
            if (history.get(i).isWebHidden()) {
                hiddenInstruction = i;
                break;
            }
        }
        if (hiddenInstruction < 0) return false;
        for (int i = hiddenInstruction + 1; i < history.size(); i++) {
            ChatMessage message = history.get(i);
            if (message.isTool()) return true;
            if (!message.isAssistant()) continue;
            if (message.getContent() != null && !message.getContent().isBlank()) return true;
            if (message.getReasoningContent() != null && !message.getReasoningContent().isBlank()) return true;
            if (message.hasToolCalls()) return true;
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

        long promptTokens = 0;
        long completionTokens = 0;
        long cacheHit = 0;
        long cacheMiss = 0;
        long lastPromptTokens = 0;
        int maxContextTokens = 128000;

        if (agent != null) {
            long[] usage = agent.getSessionUsage();
            promptTokens = usage[0];
            completionTokens = usage[1];
            cacheHit = usage[2];
            cacheMiss = usage[3];
            lastPromptTokens = usage.length > 4 ? usage[4] : 0;
            maxContextTokens = agent.getMaxContextTokens();
        }

        String currentModel = null;
        boolean hasPrice = false;
        double inputCost = 0;
        double cacheCost = 0;
        double outputCost = 0;
        double totalCost = 0;
        String currency = null;

        // 价格计算：优先按模型分别计费，解决模型中途切换导致计价错乱
        try {
            LoopraConfig config = ConfigService.getConfig();
            currentModel = agent != null && agent.getModel() != null ? agent.getModel() : config.model();
            Map<String, Map<String, Double>> prices = config.price();

            if (agent == null) {
                log.warn("[usage] Agent 为 null，无法获取模型用量");
                return new UsageDTO(0, 0, 0, 0, 0, maxContextTokens, 0, null, false, 0, 0, 0, 0, null, null);
            }
            Map<String, long[]> mu = agent.getModelUsage();

            if (mu != null && !mu.isEmpty()) {
                // 全局价格提供者（与 UsageCostCalculator.calc() 行为对齐：config 优先，provider 兜底）
                ModelPriceProvider priceProvider = ModelMetaPriceProvider.getInstance();

                // 按模型分别计算费用
                for (Map.Entry<String, long[]> entry : mu.entrySet()) {
                    String modelName = entry.getKey();
                    long[] usage = entry.getValue();

                    // 1) 优先从用户配置中取价
                    Map<String, Double> modelPrice = prices.get(modelName);

                    // 2) 配置中没有时回退到 ModelPriceProvider（与 DashboardService / UsageCostCalculator 保持一致）
                    if ((modelPrice == null || modelPrice.isEmpty()) && priceProvider != null) {
                        modelPrice = priceProvider.getModelPrice(modelName);
                        if (modelPrice == null || modelPrice.isEmpty()) {
                            log.debug("[usage] 模型 '{}' 既无 config.price() 配置，也无 ModelPriceProvider 元数据，跳过计价", modelName);
                        }
                    }

                    if (modelPrice != null && !modelPrice.isEmpty()) {
                        hasPrice = true;
                        double inputRate = modelPrice.getOrDefault("input", 0.0);
                        double cacheRate = modelPrice.getOrDefault("cache", 0.0);
                        double outputRate = modelPrice.getOrDefault("output", 0.0);

                        long nonCacheInput = Math.max(0, usage[0] - usage[2]);
                        inputCost += nonCacheInput / 1_000_000.0 * inputRate;
                        cacheCost += usage[2] / 1_000_000.0 * cacheRate;
                        outputCost += usage[1] / 1_000_000.0 * outputRate;
                    }
                }
                totalCost = inputCost + cacheCost + outputCost;
                currency = hasPrice ? "CNY" : null;

                inputCost = Math.round(inputCost * 10000.0) / 10000.0;
                cacheCost = Math.round(cacheCost * 10000.0) / 10000.0;
                outputCost = Math.round(outputCost * 10000.0) / 10000.0;
                totalCost = Math.round(totalCost * 10000.0) / 10000.0;
            } else {
                // 无 per-model 数据（旧格式 .usage 文件），回退到当前模型计费
                totalCost = UsageCostCalculator.calc(prices, currentModel, promptTokens, completionTokens, cacheHit);
                hasPrice = totalCost > 0;
                currency = hasPrice ? "CNY" : null;
                inputCost = totalCost;
                totalCost = Math.round(totalCost * 10000.0) / 10000.0;
                inputCost = Math.round(inputCost * 10000.0) / 10000.0;
            }
        } catch (Exception e) {
            // 价格计算失败不影响主逻辑
        }

        ContextTokenEstimate contextEstimate = agent != null ? agent.getLastContextEstimate() : null;
        if (contextEstimate == null && agent != null) {
            contextEstimate = agent.estimateCurrentContext();
        }
        return new UsageDTO(
                promptTokens, completionTokens, cacheHit, cacheMiss,
                lastPromptTokens, maxContextTokens,
                promptTokens + completionTokens,
                currentModel, hasPrice,
                inputCost, cacheCost, outputCost, totalCost,
                currency, contextEstimate
        );
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
        LoopraAgent removed = sessionCache.remove(sessionKey);
        if (removed != null) {
            try {
                removed.flushSession();
                removed.saveUsage();
            } catch (Exception e) {
                log.warn("[web] 清除 Agent 失败: {}", e.getMessage());
            }
            log.info("[web] 已清除 Agent: " + sessionKey);
        }
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
        for (Map.Entry<String, LoopraAgent> entry : sessionCache.entrySet()) {
            LoopraAgent agent = entry.getValue();
            if (agent != null) {
                try {
                    agent.flushSession();
                    agent.saveUsage();
                } catch (Exception e) {
                    log.warn("[web] 清除 Agent 失败: {}", e.getMessage());
                }
            }
        }
        sessionCache.clear();
        log.info("[web] 已清除所有 Agent 缓存");
    }

    /**
     * 通过项目 hash（或路径本身）反查项目路径。
     */
    public String resolveProjectPath(String hash) {
        if (hash == null || hash.isEmpty()) {
            return null;
        }
        // 1. 优先使用 ProjectRegistry 的磁盘索引（可靠，不依赖 sessionCache）
        try {
            ProjectRegistry projects = new ProjectRegistry();
            List<ProjectRegistry.ProjectInfo> projectList = projects.listProjects();
            for (ProjectRegistry.ProjectInfo ws : projectList) {
                if (hash.equals(ws.hash())) {
                    return ws.path();
                }
            }
        } catch (Exception e) {
            log.warn("[web] 读取项目列表失败: {}", e.getMessage());
        }

        // 2. 检查默认项目
        String defaultPath = getCurrentProject();
        if (defaultPath != null && hash.equals(ProjectRegistry.computeProjectHash(defaultPath))) {
            return defaultPath;
        }

        // 3. 遍历缓存的 Agent key（兼容旧版）
        for (String key : sessionCache.keySet()) {
            String projectPath = key.split("::", 2)[0];
            if (hash.equals(ProjectRegistry.computeProjectHash(projectPath))) {
                return projectPath;
            }
        }

        // 4. 兼容：hash 可能就是路径本身（旧前端直接传路径）
        if (hash.contains("/") || hash.contains("\\")) {
            return hash;
        }

        // 5. 无法解析
        return null;
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
        if (hashes == null || hashes.isEmpty()) return null;
        LinkedHashSet<String> requested = hashes.stream()
                .filter(Objects::nonNull)
                .map(String::trim)
                .filter(hash -> !hash.isEmpty() && !hash.equals(primaryHash))
                .collect(Collectors.toCollection(LinkedHashSet::new));
        if (requested.isEmpty()) return null;
        if (requested.size() > 8) {
            throw new ServiceException("单次最多关联 8 个项目");
        }

        Map<String, ProjectInfoDTO> registered = listProjects().stream()
                .collect(Collectors.toMap(ProjectInfoDTO::hash, project -> project, (left, right) -> left));
        List<ProjectInfoDTO> linked = new ArrayList<>(requested.size());
        for (String hash : requested) {
            ProjectInfoDTO project = registered.get(hash);
            if (project == null) {
                throw new ServiceException("关联项目不存在或未注册: " + hash);
            }
            linked.add(project);
        }
        return formatLinkedProjectContext(linked);
    }

    static String formatLinkedProjectContext(List<ProjectInfoDTO> projects) {
        StringBuilder context = new StringBuilder("[系统注入：本轮关联项目]\n")
                .append("以下项目由用户显式选择用于本轮联动。它们不是当前主项目；读取或修改时必须遵守现有工具权限与审批边界。\n");
        for (ProjectInfoDTO project : projects) {
            String name = project.name() == null || project.name().isBlank() ? project.hash() : project.name();
            context.append("- 名称: ").append(name)
                    .append("\n  hash: ").append(project.hash())
                    .append("\n  根目录: ").append(project.path()).append('\n');
        }
        return context.toString().trim();
    }

    public String getCurrentProject() {
        LoopraConfig cfg = ConfigService.getConfig();
        if (cfg != null && cfg.workspaceDir() != null) {
            return cfg.workspaceDir().toAbsolutePath().toString();
        }
        return null;
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
        List<ProjectInfoDTO> result = new ArrayList<>();

        try {
            ProjectRegistry projectRegistry = new ProjectRegistry();
            // 不要在这里调用 switchProject，否则 list 会产生自动创建副作用。
            List<ProjectRegistry.ProjectInfo> projects = projectRegistry.listProjects();

            for (ProjectRegistry.ProjectInfo info : projects) {
                result.add(new ProjectInfoDTO(
                        info.hash(), info.name(), info.path(),
                        info.createdAt(), info.lastAccessedAt(),
                        info.sessionCount()
                ));
            }
        } catch (IOException e) {
            log.warn("[web] 获取项目列表失败: {}", e.getMessage());
            // 回退到旧逻辑：从缓存中收集
            Set<String> projectPaths = new HashSet<>();
            for (String key : sessionCache.keySet()) {
                String[] parts = key.split("::", 2);
                if (parts.length > 0) {
                    projectPaths.add(parts[0]);
                }
            }

            LoopraConfig cfg = ConfigService.getConfig();
            if (cfg != null && cfg.workspaceDir() != null) {
                projectPaths.add(cfg.workspaceDir().toAbsolutePath().toString());
            }

            for (String path : projectPaths) {
                result.add(new ProjectInfoDTO(
                        ProjectRegistry.computeProjectHash(path), null, path,
                        0, 0, 0
                ));
            }
        }

        return applyProjectOrder(result, ConfigService.getWorkspaceOrder());
    }

    /**
     * 按用户保存的顺序合并项目列表：
     * order 中的 hash 按保存顺序排列在前，未保存过排序的项目按原顺序追加到末尾，
     * order 中已不存在（被删除）的 hash 自动忽略。
     */
    public static List<ProjectInfoDTO> applyProjectOrder(List<ProjectInfoDTO> projects, List<String> order) {
        if (projects == null || projects.isEmpty() || order == null || order.isEmpty()) {
            return projects;
        }
        Map<String, ProjectInfoDTO> byHash = new LinkedHashMap<>();
        for (ProjectInfoDTO project : projects) {
            byHash.put(project.hash(), project);
        }
        List<ProjectInfoDTO> result = new ArrayList<>(projects.size());
        Set<String> placed = new HashSet<>();
        for (String hash : order) {
            ProjectInfoDTO project = byHash.get(hash);
            if (project != null && placed.add(hash)) {
                result.add(project);
            }
        }
        for (ProjectInfoDTO project : projects) {
            if (placed.add(project.hash())) {
                result.add(project);
            }
        }
        return result;
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

    // ==================== 命令与 Skill 查询 ====================

    /**
     * 获取所有命令的元数据列表（供前端命令选择弹窗使用）。
     *
     * @return 命令元数据列表
     */
    public String executeScheduledTask(String workspacePath, String sessionName, String message) {
        String sessionKey = generateSessionKey(workspacePath, sessionName);
        ReentrantLock lock = sessionCache.getLock(sessionKey);
        lock.lock();

        String effectiveSessionName = sessionName != null ? sessionName : "default";
        CURRENT_SESSION_NAME.set(effectiveSessionName);
        LoopraModelProvider.CURRENT_LOG_SESSION.set(effectiveSessionName);

        try {
            LoopraAgent agent = getOrCreateAgent(sessionKey);

            agent.setOutput(AgentOutput.NOOP);
            String sessionId = sessionName != null ? sessionName : "default";
            agent.setSessionId(sessionId);
            return agent.chat(UserMessage.of(message));
        } catch (Exception e) {
            log.warn("[schedule] 定时任务执行异常: {}", e.getMessage());
            return "错误：" + e.getMessage();
        } finally {
            CURRENT_SESSION_NAME.remove();
            LoopraAgent agent = sessionCache.get(sessionKey);
            if (agent != null) {
                agent.setOutput(AgentOutput.NOOP);
                agent.flushSession();
                agent.saveUsage();
            }
            lock.unlock();
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
        ReentrantLock lock = sessionCache.getLock(sessionKey);
        lock.lock();

        String effectiveSessionName = sessionName != null ? sessionName : "default";
        CURRENT_SESSION_NAME.set(effectiveSessionName);
        LoopraModelProvider.CURRENT_LOG_SESSION.set(effectiveSessionName);

        try {
            SessionStore.SessionModelSettings sessionSettings = resolveSessionModelSettings(
                    workspacePath, effectiveSessionName, requestedModel, requestedChannelId, requestedReasoningEffort);
            LoopraAgent agent = getOrCreateAgentWithPrompt(sessionKey, sessionSettings, systemPrompt);
            if (requestedHitl != null && !requestedHitl.isBlank()) {
                agent.setHitlMode(requestedHitl.trim());
            }
            agent.setOutput(AgentOutput.NOOP);
            agent.setSessionId(effectiveSessionName);
            UserMessage userMessage = UserMessage.of(message);
            userMessage.setWebHidden(webHidden);
            return agent.chat(userMessage);
        } finally {
            CURRENT_SESSION_NAME.remove();
            LoopraModelProvider.CURRENT_LOG_SESSION.remove();
            LoopraAgent agent = sessionCache.get(sessionKey);
            if (agent != null) {
                agent.setOutput(AgentOutput.NOOP);
                agent.flushSession();
                agent.saveUsage();
            }
            lock.unlock();
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
        ReentrantLock lock = sessionCache.getLock(sessionKey);
        lock.lock();

        String effectiveSessionName = sessionName != null ? sessionName : "default";
        CURRENT_SESSION_NAME.set(effectiveSessionName);
        LoopraModelProvider.CURRENT_LOG_SESSION.set(effectiveSessionName);
        try {
            LoopraAgent agent = sessionCache.get(sessionKey);
            if (agent == null || agent.noPendingHITL()) {
                throw new ServiceException("当前需求没有待审批的工具调用");
            }
            if (approved) {
                agent.approveHITL();
            } else {
                agent.denyHITL();
            }
            agent.setOutput(AgentOutput.NOOP);
            agent.setSessionId(effectiveSessionName);
            return agent.chat(null);
        } finally {
            CURRENT_SESSION_NAME.remove();
            LoopraModelProvider.CURRENT_LOG_SESSION.remove();
            LoopraAgent agent = sessionCache.get(sessionKey);
            if (agent != null) {
                agent.setOutput(AgentOutput.NOOP);
                agent.flushSession();
                agent.saveUsage();
            }
            lock.unlock();
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
