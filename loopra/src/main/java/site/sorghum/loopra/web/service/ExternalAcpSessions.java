package site.sorghum.loopra.web.service;

import com.agentclientprotocol.sdk.error.AcpProtocolException;
import com.agentclientprotocol.sdk.spec.AcpClientSession;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import site.sorghum.loopra.bin.acp.AcpConfigOption;
import site.sorghum.loopra.bin.acp.AcpMcpServers;
import com.agentclientprotocol.sdk.spec.AcpSchema.McpServer;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.bin.session.SessionStore;
import site.sorghum.loopra.bin.session.SessionService;
import site.sorghum.loopra.bin.model.ToolModelService;
import site.sorghum.loopra.bin.session.SubAgentSessionStore;
import site.sorghum.loopra.tool.AgentOutput;
import site.sorghum.loopra.web.common.ServiceException;

import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.locks.ReentrantLock;

/** Persistent isolated conversation clients, with compatible initialized adapters shared between them. */
final class ExternalAcpSessions implements AutoCloseable {
    private static final Logger log = LoggerFactory.getLogger(ExternalAcpSessions.class);
    private static final int MAX_CONNECTIONS = 8;
    private final Map<String, Connection> connections = new HashMap<>();
    private final java.util.function.BiFunction<String, Path, com.agentclientprotocol.sdk.spec.AcpClientTransport> transportFactory;
    private final java.util.function.BiFunction<String, Path, List<McpServer>> mcpResolver;
    private final SharedAcpProcesses sharedProcesses;

    ExternalAcpSessions() { this((id, cwd) -> ExternalAcpProviders.require(id).create(cwd),
            (key, cwd) -> AcpMcpServers.managed(key.contains("::") ? Path.of(key.split("::", 2)[0]) : cwd), true); }
    ExternalAcpSessions(java.util.function.Function<Path, com.agentclientprotocol.sdk.spec.AcpClientTransport> factory) {
        this(factory, (key, cwd) -> AcpMcpServers.managed(key.contains("::") ? Path.of(key.split("::", 2)[0]) : cwd));
    }

    ExternalAcpSessions(java.util.function.Function<Path, com.agentclientprotocol.sdk.spec.AcpClientTransport> factory,
                        java.util.function.BiFunction<String, Path, List<McpServer>> mcpResolver) {
        this((id, cwd) -> factory.apply(cwd), mcpResolver);
    }

    ExternalAcpSessions(java.util.function.BiFunction<String, Path, com.agentclientprotocol.sdk.spec.AcpClientTransport> factory,
                        java.util.function.BiFunction<String, Path, List<McpServer>> mcpResolver) {
        this(factory, mcpResolver, false);
    }

    ExternalAcpSessions(java.util.function.BiFunction<String, Path, com.agentclientprotocol.sdk.spec.AcpClientTransport> factory,
                        java.util.function.BiFunction<String, Path, List<McpServer>> mcpResolver, boolean shareProcesses) {
        transportFactory = factory;
        this.mcpResolver = mcpResolver;
        sharedProcesses = shareProcesses ? new SharedAcpProcesses(factory) : null;
    }

    private com.agentclientprotocol.sdk.spec.AcpClientTransport transport(Connection connection, Path cwd, String name,
                                                                         SessionStore store, List<String> directories) throws Exception {
        String remote = store.getAcpBinding(name).remoteSessionId();
        connection.adapterReused = false;
        if (sharedProcesses != null && remote != null && !remote.isBlank() && store.hasMessages(name)) {
            var transport = sharedProcesses.borrow(connection.agentId, cwd, directories, connection.mcpServers, remote);
            connection.adapterReused = SharedAcpProcesses.reusesHandshake(transport);
            return transport;
        }
        return transportFactory.apply(connection.agentId, cwd);
    }

    void prompt(String key, Path cwd, String name, SessionStore store, UserMessage message,
                AgentOutput output, boolean plan, String linkedProjectContext, List<String> linkedProjectDirectories,
                java.util.function.Consumer<AcpWorkbenchClient> active,
                java.util.function.Consumer<AcpWorkbenchClient> inactive) throws Exception {
        Connection connection = acquire(key, cwd, store.getAcpBinding(name).agentId(), true);
        // Anything constructed after the lock is held must happen inside the try:
        // a failure here would otherwise leak the lock and the session would look
        // "running" for every later request.
        AcpTranscriptOutput[] transcriptRef = new AcpTranscriptOutput[1];
        AcpSubAgentRecorder[] recorderRef = new AcpSubAgentRecorder[1];
        boolean success = false;
        try {
            refreshMcp(connection, key, cwd);
            List<String> directories = linkedProjectDirectories == null ? List.of() : List.copyOf(linkedProjectDirectories);
            AcpTranscriptOutput transcript = new AcpTranscriptOutput(output, store);
            transcriptRef[0] = transcript;
            Path sessionsDir = store.sessionsDir();
            AcpSubAgentRecorder recorder = sessionsDir == null ? null
                    : new AcpSubAgentRecorder(new SubAgentSessionStore(sessionsDir), name);
            recorderRef[0] = recorder;
            // A configuration read may have opened a session before linked projects were known.
            // ACP binds additionalDirectories at session setup, so rebuild the empty session;
            // the transcript is still empty, which makes the rebuild free.
            if (connection.client != null && connection.client.sessionId() != null
                    && !connection.directories.equals(directories) && store.load(name).isEmpty()) {
                connection.client.close();
                connection.client = null;
                connection.directories = List.of();
            }
            if (connection.client == null) connection.client = new AcpWorkbenchClient(transport(connection, cwd, name, store, directories), transcript,
                    "codex".equals(connection.agentId));
            else connection.client.bindOutput(transcript);
            AcpWorkbenchClient client = connection.client;
            client.setMessageListener(transcript::message);
            // Both flattened Claude traffic and native Codex child sessions use the replay store.
            client.setSubAgentListener(recorder == null ? null : recorder::record);
            active.accept(client);
            open(connection, cwd, name, store, directories);
            ChatMessage user = message.getImages().isEmpty() ? ChatMessage.ofUser(message.getText())
                    : ChatMessage.ofUser(message.getText(), message.getImages());
            user.setSnapshotId(message.getSnapshotId()); user.setRollbackId(message.getRollbackId());
            boolean firstMessage = !store.hasMessages(name);
            store.bindTo(name); store.append(user);
            if (firstMessage && (store.getTitle(name) == null || store.getTitle(name).isBlank())) {
                String initialTitle = SessionService.fallbackTitle(message.getText());
                store.updateTitle(name, initialTitle);
                CompletableFuture.runAsync(() -> {
                    String title = ToolModelService.generateTitle(SessionService.titleSource(message.getText()));
                    if (title != null && initialTitle.equals(store.getTitle(name))) {
                        try { store.updateTitle(name, title); }
                        catch (java.io.IOException error) { log.warn("[acp] 保存生成标题失败: session={}", name, error); }
                    }
                });
            }
            // The linked-project context is turn-scoped. Inject it into what the Agent sees,
            // but keep the workbench transcript (and the stored user message) unchanged.
            String text = linkedProjectContext == null || linkedProjectContext.isBlank() ? message.getText()
                    : linkedProjectContext + "\n\n" + (message.getText() == null ? "" : message.getText());
            UserMessage outbound = java.util.Objects.equals(text, message.getText())
                    ? message : UserMessage.of(text, message.getImages());
            var response = client.prompt(outbound, Map.of());
            if (response == null || response.stopReason() == null) throw new ServiceException("Agent 未返回回合结束原因");
            String reason = response.stopReason().name().toLowerCase(Locale.ROOT);
            String notice = switch (response.stopReason()) {
                case MAX_TOKENS -> "Agent 已达到本轮输出上限，任务可能尚未完成";
                case MAX_TURN_REQUESTS -> "Agent 已达到本轮请求次数上限，任务可能尚未完成";
                case REFUSAL -> "Agent 拒绝了本次请求";
                default -> null;
            };
            if (notice != null) output.onLog(site.sorghum.loopra.tool.LogLevel.WARN, notice);
            output.sendEvent("complete", org.noear.snack4.ONode.serialize(Map.of("stopReason", reason,
                    "status", switch (response.stopReason()) {
                        case END_TURN -> "completed";
                        case CANCELLED -> "cancelled";
                        case REFUSAL -> "refused";
                        default -> "limited";
                    })));
            success = true;
        } catch (Exception failure) {
            throw translateFailure(failure);
        } finally {
            boolean interrupted = Thread.interrupted();
            try {
                // Persist the last buffered subagent text before the turn's store is released.
                if (recorderRef[0] != null) recorderRef[0].finish();
                if (transcriptRef[0] != null) transcriptRef[0].finish();
            } finally {
                try {
                    if (connection.client != null) {
                        inactive.accept(connection.client);
                        connection.client.setMessageListener(null);
                        connection.client.bindOutput(AgentOutput.NOOP);
                    }
                    if (!success) discard(key, connection);
                } finally {
                    connection.lastUsed = System.nanoTime();
                    connection.prompting = false;
                    connection.lock.unlock();
                    if (interrupted) Thread.currentThread().interrupt();
                }
            }
        }
    }

    List<site.sorghum.loopra.bin.acp.AcpConfigOption> configuration(String key, Path cwd, String name,
                    SessionStore store, String configId, Object value) throws Exception {
        try (var timing = new AcpStartupTiming(store.getAcpBinding(name).agentId(), configId == null ? "read" : "write")) {
            var options = configuration(key, cwd, name, store, configId, value, timing);
            timing.success();
            return options;
        }
    }

    List<site.sorghum.loopra.bin.acp.AcpConfigOption> configuration(String key, Path cwd, String name,
                    SessionStore store, String configId, Object value, AcpStartupTiming timing) throws Exception {
        Connection connection;
        try (var phase = AcpStartupTiming.step(timing, "acquire")) {
            connection = acquire(key, cwd, store.getAcpBinding(name).agentId(), false);
        }
        AcpSubAgentRecorder recorder = null;
        boolean success = false;
        try {
            try (var phase = AcpStartupTiming.step(timing, "mcpConfig")) { refreshMcp(connection, key, cwd); }
            if (connection.client == null) {
                timing.cold();
                try (var phase = AcpStartupTiming.step(timing, "clientCreate")) {
                    connection.client = new AcpWorkbenchClient(transport(connection, cwd, name, store, connection.directories), AgentOutput.NOOP,
                            "codex".equals(connection.agentId));
                    if (connection.adapterReused) timing.adapterReused();
                }
            }
            if (store.sessionsDir() != null) {
                recorder = new AcpSubAgentRecorder(new SubAgentSessionStore(store.sessionsDir()), name);
                connection.client.setSubAgentListener(recorder::record);
            }
            // Configuration reads must not pretend the linked-directory set changed.
            // The workbench already owns its transcript. Reading toolbar options needs
            // a live session, but not a second copy of its entire history over stdio.
            open(connection, cwd, name, store, connection.directories, timing, false);
            List<AcpConfigOption> options;
            try (var phase = AcpStartupTiming.step(timing, "configReadOrWrite")) {
                options = configId == null ? connection.client.configOptions() : connection.client.setConfigOption(configId, value);
            }
            if (configId != null) {
                Map<String, String> saved = new LinkedHashMap<>(store.getAgentConfig(name));
                saved.put(configId, org.noear.snack4.ONode.serialize(value));
                store.setAgentConfig(name, saved);
            }
            success = true;
            return options;
        } catch (Exception failure) {
            throw translateFailure(failure);
        } finally {
            boolean interrupted = Thread.interrupted();
            try {
                if (!success) discard(key, connection);
                if (recorder != null) recorder.finish();
            }
            finally {
                connection.lastUsed = System.nanoTime(); connection.lock.unlock();
                if (interrupted) Thread.currentThread().interrupt();
            }
        }
    }

    void fork(String key, Path cwd, String sourceName, SessionStore source, String name, SessionStore target,
              List<String> additionalDirectories) throws Exception {
        fork(key, cwd, sourceName, source, name, target, additionalDirectories, null);
    }

    void fork(String key, Path cwd, String sourceName, SessionStore source, String name, SessionStore target,
              List<String> additionalDirectories, Integer messageCount) throws Exception {
        var binding = source.getAcpBinding(sourceName);
        if (binding.remoteSessionId() == null || binding.remoteSessionId().isBlank()) {
            throw new ServiceException("源会话尚未建立远端记录，无法创建分叉");
        }
        List<ChatMessage> sourceHistory = source.load(sourceName);
        AcpForkPoint point = messageCount == null ? new AcpForkPoint(sourceHistory, null) : AcpForkPoint.at(sourceHistory, messageCount);
        Connection connection = acquire(key, cwd, binding.agentId(), false);
        boolean success = false;
        try {
            refreshMcp(connection, key, cwd);
            AcpWorkbenchClient client = new AcpWorkbenchClient(transportFactory.apply(connection.agentId, cwd),
                    AgentOutput.NOOP, "codex".equals(connection.agentId));
            connection.client = client;
            List<String> directories = additionalDirectories == null ? List.of() : List.copyOf(additionalDirectories);
            CompletableFuture<String> opening = CompletableFuture.supplyAsync(() ->
                    client.fork(cwd.toString(), binding.remoteSessionId(), directories, connection.mcpServers, point.meta()));
            String id;
            try { id = opening.get(60, TimeUnit.SECONDS); }
            catch (Exception e) { opening.cancel(true); throw e; }
            if (!target.bindTo(name)) throw new ServiceException("无法创建分叉会话");
            target.rewrite(point.history());
            target.updateTitle(name, AgentService.branchTitle(source.getTitle(sourceName), sourceName));
            target.setAcpBinding(name, new SessionStore.AcpBinding(binding.agentId(), id, cwd.toString()));
            target.setAgentConfig(name, source.getAgentConfig(sourceName));
            restoreConfiguration(client, name, target);
            connection.directories = directories;
            target.flush();
            success = true;
        } catch (Exception failure) {
            throw translateFailure(failure);
        } finally {
            boolean interrupted = Thread.interrupted();
            try {
                if (!success) {
                    discard(key, connection);
                    target.shutdown();
                    target.delete(name);
                }
            } finally {
                connection.lastUsed = System.nanoTime();
                connection.lock.unlock();
                if (interrupted) Thread.currentThread().interrupt();
            }
        }
    }

    private static Exception translateFailure(Exception failure) {
        Throwable cause = failure;
        while ((cause instanceof ExecutionException || cause instanceof CompletionException) && cause.getCause() != null) {
            cause = cause.getCause();
        }
        if (cause instanceof AcpClientSession.AcpError error && error.getData() instanceof Map<?, ?> data
                && "thread_active_writer".equals(data.get("reason"))) {
            return new ServiceException(409,
                    "Codex 会话已被其他客户端占用。请在 Codex 桌面端、CLI 或 IDE 中关闭该会话后重试，"
                            + "或在 Loopra 创建会话分叉继续。原会话历史已保留。", "thread_active_writer");
        }
        if (cause instanceof ServiceException business) return business;
        if (cause instanceof AcpClientSession.AcpError error) {
            return new ServiceException(502, "Agent 请求失败：" + error.getMessage());
        }
        return failure;
    }

    private void refreshMcp(Connection connection, String key, Path cwd) {
        List<McpServer> desired = List.copyOf(mcpResolver.apply(key, cwd));
        if ("pi".equals(connection.agentId) && !desired.isEmpty()) {
            throw new ServiceException("pi-acp 暂不转发工作台 MCP，请先在工作台停用这些 MCP，并在 Pi 中配置所需扩展");
        }
        if (!connection.mcpServers.equals(desired)) {
            // ACP binds MCP at new/load. Reconnect before the next turn to apply edits,
            // including revoked servers, while retaining the persisted remote session id.
            if (connection.client != null) connection.client.close();
            connection.client = null;
            connection.mcpServers = desired;
        }
    }

    private void open(Connection connection, Path cwd, String name, SessionStore store,
                      List<String> additionalDirectories) throws Exception {
        open(connection, cwd, name, store, additionalDirectories, null, true);
    }

    private void open(Connection connection, Path cwd, String name, SessionStore store,
                      List<String> additionalDirectories, AcpStartupTiming timing, boolean replayHistory) throws Exception {
        AcpWorkbenchClient client = connection.client;
        client.setPlanListener(entries -> {
            try { store.setAcpPlan(name, entries); }
            catch (java.io.IOException e) { log.warn("[acp] 保存计划进度失败: session={}", name, e); }
        });
        client.setCommandsListener(commands -> {
            try { store.setAcpCommands(name, commands); }
            catch (java.io.IOException e) { log.warn("[acp] 保存命令列表失败: session={}", name, e); }
        });
        List<String> directories = additionalDirectories == null ? List.of() : List.copyOf(additionalDirectories);
        if ("dsh".equals(connection.agentId) && !directories.isEmpty()) {
            throw new ServiceException("DSH ACP 只支持一个工作目录，请取消关联项目后重试");
        }
        if (client.sessionId() != null) {
            if (!connection.directories.equals(directories)) {
                // ACP binds additionalDirectories at session setup; the prompt text still
                // carries the context each turn, and a recreated connection picks up the new set.
                log.warn("[acp] Agent 会话已建立，关联项目目录变更将在连接重建后生效: session={}", name);
            }
            // Each turn gets a new SessionStore instance, so the persistence hook
            // must follow the store currently in use.
            client.setConfigListener(options -> persistConfiguration(store, name, options));
            client.setUsageListener(usage -> persistUsage(store, name, usage));
            return;
        }
        SessionStore.AcpBinding binding = store.getAcpBinding(name);
        if (!connection.agentId.equals(binding.agentId())) throw new ServiceException(409, "Agent 会话绑定已变化，请重试");
        if (binding.cwd() != null && !Path.of(binding.cwd()).equals(cwd)) throw new ServiceException("Agent 会话工作目录已变化，请创建新会话");
        // Before the first prompt, some Agents have not written a resumable transcript yet.
        String restoreId;
        try (var phase = AcpStartupTiming.step(timing, "historyCheck")) {
            restoreId = store.hasMessages(name) ? binding.remoteSessionId() : null;
        }
        // Setup responses also carry configOptions. Keep persistence disabled until the
        // saved choices have been restored, otherwise defaults overwrite the user's picks.
        client.setConfigListener(null);
        CompletableFuture<String> opening = CompletableFuture.supplyAsync(() -> client.open(cwd.toString(), restoreId, directories, connection.mcpServers, timing, replayHistory));
        String id;
        try { id = opening.get(60, TimeUnit.SECONDS); }
        catch (Exception e) { opening.cancel(true); throw e; }
        try (var phase = AcpStartupTiming.step(timing, "bindingPersist")) {
            store.setAcpBinding(name, new SessionStore.AcpBinding(connection.agentId, id, cwd.toString()));
        }
        try (var phase = AcpStartupTiming.step(timing, "restoreOptions")) { restoreConfiguration(client, name, store); }
        connection.directories = directories;
        client.setConfigListener(options -> persistConfiguration(store, name, options));
        client.setUsageListener(usage -> persistUsage(store, name, usage));
    }

    /**
     * Context usage is per conversation, so it survives process restarts and session switches.
     * <p>A fresh process only learns the cost at the result message; a cancelled turn may
     * end after a cost-less mid-stream update, so keep the previous cost in that case.</p>
     */
    private void persistUsage(SessionStore store, String name, AcpWorkbenchClient.Usage usage) {
        try {
            SessionStore.AcpUsage previous = store.getAcpUsage(name);
            store.setAcpUsage(name, new SessionStore.AcpUsage(usage.used(), usage.size(),
                    usage.cost() != null ? usage.cost() : previous == null ? null : previous.cost(),
                    usage.currency() != null ? usage.currency() : previous == null ? null : previous.currency(),
                    usage.model() != null ? usage.model() : previous == null ? null : previous.model()));
        } catch (java.io.IOException e) {
            log.warn("[acp] 保存上下文用量失败: session={}, 原因={}", name, e.getMessage());
        }
    }

    /** Persist the Agent's current configuration, including changes it makes itself. */
    private void persistConfiguration(SessionStore store, String name, List<AcpConfigOption> options) {
        Map<String, String> values = new LinkedHashMap<>();
        for (AcpConfigOption option : options) {
            if (option.currentValue() != null) values.put(option.id(), org.noear.snack4.ONode.serialize(option.currentValue()));
        }
        try { store.setAgentConfig(name, values); }
        catch (java.io.IOException e) { log.warn("[acp] 保存 Agent 配置失败: session={}, 原因={}", name, e.getMessage()); }
    }

    /**
     * Restore explicit workbench choices, dropping values the Agent no longer supports.
     * <p>A saved value can become unavailable after a model retires, a permission mode is
     * disabled, the adapter changes, or an older build left another engine's keys behind.
     * Such an entry must never fail {@code open()}: configuration reads also need an open
     * connection, so a hard failure would leave the user unable to repair the session.</p>
     */
    private void restoreConfiguration(AcpWorkbenchClient client, String name, SessionStore store) throws Exception {
        Map<String, String> savedConfig = new LinkedHashMap<>(store.getAgentConfig(name));
        Map<String, Object> applied = new LinkedHashMap<>();
        for (var saved : savedConfig.entrySet()) {
            Object value;
            try {
                value = org.noear.snack4.ONode.ofJson(saved.getValue()).toBean(Object.class);
            } catch (RuntimeException e) {
                log.warn("[acp] 忽略无法解析的 Agent 配置: session={}, id={}, value={}", name, saved.getKey(), saved.getValue());
                continue;
            }
            AcpConfigOption current = option(client.configOptions(), saved.getKey());
            if (current == null || !current.accepts(value)) {
                log.warn("[acp] 忽略当前 Agent 不支持的配置: session={}, id={}, value={}", name, saved.getKey(), saved.getValue());
                continue;
            }
            if (!Objects.equals(current.currentValue(), value)) {
                try {
                    client.setConfigOption(saved.getKey(), value);
                } catch (AcpClientSession.AcpError | AcpProtocolException | ServiceException | IllegalArgumentException e) {
                    // The Agent rejected this value, but the connection itself is healthy.
                    // Transport and process failures deliberately propagate: they are not
                    // configuration problems and must not be hidden.
                    log.warn("[acp] 恢复 Agent 配置失败，已忽略: session={}, id={}, value={}, 原因={}",
                            name, saved.getKey(), saved.getValue(), e.getMessage());
                    continue;
                }
            }
            applied.put(saved.getKey(), value);
        }
        // A model switch may retire values for other options; persist only the final accepted state.
        List<AcpConfigOption> options = client.configOptions();
        Map<String, String> persisted = new LinkedHashMap<>();
        applied.forEach((id, value) -> {
            AcpConfigOption current = option(options, id);
            if (current != null && current.accepts(value)) persisted.put(id, org.noear.snack4.ONode.serialize(value));
        });
        if (!persisted.equals(savedConfig)) store.setAgentConfig(name, persisted);
    }

    private static AcpConfigOption option(List<AcpConfigOption> options, String id) {
        return options.stream().filter(option -> option.id().equals(id)).findFirst().orElse(null);
    }

    /**
     * Reserve the conversation's connection for one operation.
     *
     * <p>Opening a configuration request also owns the Agent process: it may have to
     * spawn the process and create/load the remote session, which takes seconds. A
     * prompt that arrives in that window used to fail with "当前会话正在运行" even
     * though the conversation was not running at all (the UI issues a configuration
     * read as soon as a freshly created session is selected). A prompt therefore
     * waits for that preparation to finish, while a second prompt for a turn that is
     * genuinely running is rejected at once. Configuration reads keep failing fast
     * during a turn because the workbench disables them then.</p>
     */
    private Connection acquire(String key, Path cwd, String agentId, boolean prompt) {
        if (!ExternalAcpProviders.isExternal(agentId)) throw new ServiceException("需要外部 Agent");
        for (int attempt = 0; attempt < 3; attempt++) {
            Connection connection;
            boolean created = false;
            synchronized (this) {
                connection = connections.get(key);
                if (connection != null) {
                    if (!connection.agentId.equals(agentId)) throw new ServiceException(409, "Agent 会话绑定已变化，请重试");
                    if (!connection.cwd.equals(cwd)) throw new ServiceException("Agent 会话工作目录已变化，请创建新会话");
                    if (prompt && connection.prompting) throw new ServiceException(409, "当前会话正在运行");
                } else {
                    if (connections.size() >= MAX_CONNECTIONS) {
                        var idle = connections.entrySet().stream().filter(e -> !e.getValue().lock.isLocked())
                                .min(Comparator.comparingLong(e -> e.getValue().lastUsed)).orElseThrow(() ->
                                        new ServiceException(503, "外部 Agent 会话进程已达上限，请先停止部分任务"));
                        discard(idle.getKey(), idle.getValue());
                    }
                    connection = new Connection(cwd, agentId);
                    connections.put(key, connection);
                    created = true;
                }
            }
            if (created) {
                connection.lock.lock();
            } else if (prompt) {
                try {
                    if (!connection.lock.tryLock(60, TimeUnit.SECONDS)) {
                        throw new ServiceException(409, "会话正在准备，请稍后重试");
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new ServiceException(409, "会话正在准备，请稍后重试");
                }
            } else if (!connection.lock.tryLock()) {
                throw new ServiceException(409, "当前会话正在运行");
            }
            if (prompt) connection.prompting = true;
            synchronized (this) {
                if (connections.get(key) == connection) return connection;
            }
            // The isolation mode changed (or the session was closed) while waiting and
            // this process was discarded; retry against the replacement instead of
            // running on a dead client.
            connection.prompting = false;
            connection.lock.unlock();
        }
        throw new ServiceException(409, "会话正在切换，请稍后重试");
    }

    private synchronized void discard(String key, Connection connection) {
        connections.remove(key, connection);
        if (connection.client != null) connection.client.close();
    }

    synchronized void close(String key) {
        Connection connection = connections.remove(key);
        if (connection != null && connection.client != null) { connection.client.cancel(); connection.client.close(); }
    }
    @Override public synchronized void close() {
        RuntimeException failure = null;
        for (String key : List.copyOf(connections.keySet())) {
            try { close(key); }
            catch (RuntimeException error) { if (failure == null) failure = error; else failure.addSuppressed(error); }
        }
        try { if (sharedProcesses != null) sharedProcesses.close(); }
        catch (RuntimeException error) { if (failure == null) failure = error; else failure.addSuppressed(error); }
        if (failure != null) throw failure;
    }
    private static final class Connection {
        final Path cwd;
        final String agentId;
        final ReentrantLock lock = new ReentrantLock();
        /** A prompt owns this connection (vice versa: a held lock may be a config read). */
        volatile boolean prompting;
        AcpWorkbenchClient client;
        boolean adapterReused;
        List<String> directories = List.of();
        List<McpServer> mcpServers = List.of();
        long lastUsed = System.nanoTime();
        Connection(Path cwd, String agentId) { this.cwd = cwd; this.agentId = agentId; }
    }
}
