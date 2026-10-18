package site.sorghum.loopra.web.service;

import com.agentclientprotocol.sdk.error.AcpProtocolException;
import com.agentclientprotocol.sdk.spec.AcpClientSession;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import site.sorghum.loopra.bin.acp.AcpConfigOption;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.bin.session.SessionStore;
import site.sorghum.loopra.tool.AgentOutput;
import site.sorghum.loopra.web.common.ServiceException;

import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.locks.ReentrantLock;

/** One persistent ACP process per external conversation, bounded and independently cancellable. */
final class ExternalAcpSessions implements AutoCloseable {
    private static final Logger log = LoggerFactory.getLogger(ExternalAcpSessions.class);
    private static final int MAX_CONNECTIONS = 8;
    private final Map<String, Connection> connections = new HashMap<>();
    private final java.util.function.Function<Path, com.agentclientprotocol.sdk.spec.AcpClientTransport> transportFactory;

    ExternalAcpSessions() { this(ClaudeAcpProcess::create); }
    ExternalAcpSessions(java.util.function.Function<Path, com.agentclientprotocol.sdk.spec.AcpClientTransport> factory) {
        transportFactory = factory;
    }

    void prompt(String key, Path cwd, String name, SessionStore store, UserMessage message,
                AgentOutput output, boolean plan, String linkedProjectContext, List<String> linkedProjectDirectories,
                java.util.function.Consumer<AcpWorkbenchClient> active,
                java.util.function.Consumer<AcpWorkbenchClient> inactive) throws Exception {
        Connection connection = acquire(key, cwd);
        List<String> directories = linkedProjectDirectories == null ? List.of() : List.copyOf(linkedProjectDirectories);
        AcpTranscriptOutput transcript = new AcpTranscriptOutput(output, store);
        boolean success = false;
        try {
            // A configuration read may have opened a session before linked projects were known.
            // ACP binds additionalDirectories at session setup, so rebuild the empty session;
            // the transcript is still empty, which makes the rebuild free.
            if (connection.client != null && connection.client.sessionId() != null
                    && !connection.directories.equals(directories) && store.load(name).isEmpty()) {
                connection.client.close();
                connection.client = null;
                connection.directories = List.of();
            }
            if (connection.client == null) connection.client = new AcpWorkbenchClient(transportFactory.apply(cwd), transcript);
            else connection.client.bindOutput(transcript);
            AcpWorkbenchClient client = connection.client;
            active.accept(client);
            open(connection, cwd, name, store, directories);
            ChatMessage user = message.getImages().isEmpty() ? ChatMessage.ofUser(message.getText())
                    : ChatMessage.ofUser(message.getText(), message.getImages());
            user.setSnapshotId(message.getSnapshotId()); user.setRollbackId(message.getRollbackId());
            store.bindTo(name); store.append(user);
            // The linked-project context is turn-scoped. Inject it into what the Agent sees,
            // but keep the workbench transcript (and the stored user message) unchanged.
            String text = linkedProjectContext == null || linkedProjectContext.isBlank() ? message.getText()
                    : linkedProjectContext + "\n\n" + (message.getText() == null ? "" : message.getText());
            UserMessage outbound = java.util.Objects.equals(text, message.getText())
                    ? message : UserMessage.of(text, message.getImages());
            client.prompt(outbound, Map.of());
            output.sendEvent("complete", "{}");
            success = true;
        } finally {
            boolean interrupted = Thread.interrupted();
            try { transcript.finish(); }
            finally {
                try {
                    if (connection.client != null) {
                        inactive.accept(connection.client);
                        connection.client.bindOutput(AgentOutput.NOOP);
                    }
                    if (!success) discard(key, connection);
                } finally {
                    connection.lastUsed = System.nanoTime();
                    connection.lock.unlock();
                    if (interrupted) Thread.currentThread().interrupt();
                }
            }
        }
    }

    List<site.sorghum.loopra.bin.acp.AcpConfigOption> configuration(String key, Path cwd, String name,
                    SessionStore store, String configId, Object value) throws Exception {
        Connection connection = acquire(key, cwd);
        boolean success = false;
        try {
            if (connection.client == null) connection.client = new AcpWorkbenchClient(transportFactory.apply(cwd), AgentOutput.NOOP);
            // Configuration reads must not pretend the linked-directory set changed.
            open(connection, cwd, name, store, connection.directories);
            var options = configId == null ? connection.client.configOptions() : connection.client.setConfigOption(configId, value);
            if (configId != null) {
                Map<String, String> saved = new LinkedHashMap<>(store.getAgentConfig(name));
                saved.put(configId, org.noear.snack4.ONode.serialize(value));
                store.setAgentConfig(name, saved);
            }
            success = true;
            return options;
        } finally {
            boolean interrupted = Thread.interrupted();
            try { if (!success) discard(key, connection); }
            finally {
                connection.lastUsed = System.nanoTime(); connection.lock.unlock();
                if (interrupted) Thread.currentThread().interrupt();
            }
        }
    }

    private void open(Connection connection, Path cwd, String name, SessionStore store,
                      List<String> additionalDirectories) throws Exception {
        AcpWorkbenchClient client = connection.client;
        List<String> directories = additionalDirectories == null ? List.of() : List.copyOf(additionalDirectories);
        if (client.sessionId() != null) {
            if (!connection.directories.equals(directories)) {
                // ACP binds additionalDirectories at session setup; the prompt text still
                // carries the context each turn, and a recreated connection picks up the new set.
                log.warn("[acp] Claude 会话已建立，关联项目目录变更将在连接重建后生效: session={}", name);
            }
            // Each turn gets a new SessionStore instance, so the persistence hook
            // must follow the store currently in use.
            client.setConfigListener(options -> persistConfiguration(store, name, options));
            return;
        }
        SessionStore.AcpBinding binding = store.getAcpBinding(name);
        if (binding.cwd() != null && !Path.of(binding.cwd()).equals(cwd)) throw new ServiceException("Claude 会话工作目录已变化，请创建新会话");
        // Before the first prompt, some Agents have not written a resumable transcript yet.
        String restoreId = store.load(name).isEmpty() ? null : binding.remoteSessionId();
        // Setup responses also carry configOptions. Keep persistence disabled until the
        // saved choices have been restored, otherwise defaults overwrite the user's picks.
        client.setConfigListener(null);
        CompletableFuture<String> opening = CompletableFuture.supplyAsync(() -> client.open(cwd.toString(), restoreId, directories));
        String id;
        try { id = opening.get(60, TimeUnit.SECONDS); }
        catch (Exception e) { opening.cancel(true); throw e; }
        store.setAcpBinding(name, new SessionStore.AcpBinding("claude-code", id, cwd.toString()));
        restoreConfiguration(client, name, store);
        connection.directories = directories;
        client.setConfigListener(options -> persistConfiguration(store, name, options));
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

    private synchronized Connection acquire(String key, Path cwd) {
        Connection cached = connections.get(key);
        if (cached != null) {
            if (!cached.cwd.equals(cwd)) throw new ServiceException("Claude 会话工作目录已变化，请创建新会话");
            if (!cached.lock.tryLock()) throw new ServiceException(409, "当前会话正在运行");
            return cached;
        }
        if (connections.size() >= MAX_CONNECTIONS) {
            var idle = connections.entrySet().stream().filter(e -> !e.getValue().lock.isLocked())
                    .min(Comparator.comparingLong(e -> e.getValue().lastUsed)).orElseThrow(() ->
                            new ServiceException(503, "Claude 会话进程已达上限，请先停止部分任务"));
            discard(idle.getKey(), idle.getValue());
        }
        Connection connection = new Connection(cwd);
        connection.lock.lock();
        connections.put(key, connection);
        return connection;
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
        for (String key : List.copyOf(connections.keySet())) close(key);
    }
    private static final class Connection {
        final Path cwd;
        final ReentrantLock lock = new ReentrantLock();
        AcpWorkbenchClient client;
        List<String> directories = List.of();
        long lastUsed = System.nanoTime();
        Connection(Path cwd) { this.cwd = cwd; }
    }
}
