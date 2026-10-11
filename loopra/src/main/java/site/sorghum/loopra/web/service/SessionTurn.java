package site.sorghum.loopra.web.service;

import lombok.extern.slf4j.Slf4j;
import site.sorghum.loopra.bin.agent.core.LoopraAgent;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.model.LoopraModelProvider;
import site.sorghum.loopra.bin.session.SessionFileChangeTracker;
import site.sorghum.loopra.tool.AgentOutput;

import java.io.IOException;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.locks.ReentrantLock;

/** 单次执行的资源作用域；必须在创建线程内通过 try-with-resources 关闭。 */
@Slf4j
final class SessionTurn implements AutoCloseable {

    private final ReentrantLock lock;
    private final String sessionName;
    private final String previousLogSession;
    private final Runnable afterUnlock;
    private final long startedAt;
    private LoopraAgent agent;
    private int historyStart = -1;
    private boolean closed;

    SessionTurn(SessionAgentRegistry sessions, String sessionKey, Runnable afterUnlock) {
        String[] parts = sessionKey.split("::", 2);
        Path workspace = Path.of(parts[0]);
        this.sessionName = parts[1];
        this.afterUnlock = afterUnlock;
        this.previousLogSession = LoopraModelProvider.CURRENT_LOG_SESSION.get();
        this.lock = sessions.getLock(sessionKey);
        lock.lock();
        try {
            this.startedAt = System.currentTimeMillis();
            SessionFileChangeTracker.beginTurn(workspace, sessionName);
            LoopraModelProvider.CURRENT_LOG_SESSION.set(sessionName);
        } catch (RuntimeException | Error failure) {
            lock.unlock();
            throw failure;
        }
    }

    String sessionName() {
        return sessionName;
    }

    void bind(LoopraAgent agent, AgentOutput output) {
        this.agent = agent;
        agent.setOutput(output);
        agent.setSessionId(sessionName);
    }

    void beforeChat() {
        historyStart = agent.historySize();
    }

    @Override
    public void close() {
        if (closed) return;
        closed = true;
        RuntimeException failure = null;
        try {
            if (agent != null) {
                failure = cleanup(failure, () -> agent.setOutput(AgentOutput.NOOP));
                failure = cleanup(failure, this::persistTurnTiming);
                failure = cleanup(failure, agent::flushSession);
                failure = cleanup(failure, agent::saveUsage);
            }
        } finally {
            if (previousLogSession == null) {
                LoopraModelProvider.CURRENT_LOG_SESSION.remove();
            } else {
                LoopraModelProvider.CURRENT_LOG_SESSION.set(previousLogSession);
            }
            lock.unlock();
        }
        // 刷新只能在会话锁释放后进行；后台请求尚未注销时，刷新服务会继续延迟。
        failure = cleanup(failure, afterUnlock);
        if (failure != null) throw failure;
    }

    private static RuntimeException cleanup(RuntimeException failure, Runnable operation) {
        try {
            operation.run();
        } catch (RuntimeException exception) {
            if (failure == null) return exception;
            if (failure != exception) failure.addSuppressed(exception);
        }
        return failure;
    }

    /** 为本轮 assistant 消息补写完整耗时，审计事件日志仍保持 append-only。 */
    private void persistTurnTiming() {
        long finishedAt = System.currentTimeMillis();
        if (historyStart < 0 || finishedAt < startedAt || agent.getCtx() == null) return;
        List<ChatMessage> history = agent.getCtx().getHistory();
        boolean updated = false;
        for (int index = historyStart; index < history.size(); index++) {
            ChatMessage message = history.get(index);
            if (!message.isAssistant()) continue;
            message.setTurnStartedAt(startedAt);
            message.setTurnFinishedAt(finishedAt);
            message.setElapsedMs(finishedAt - startedAt);
            updated = true;
        }
        if (!updated || agent.getCtx().getSessionStore() == null) return;
        try {
            agent.getCtx().getSessionStore().rewrite(history);
        } catch (IOException exception) {
            log.warn("[session] 写入助手回合耗时失败", exception);
        }
    }
}
