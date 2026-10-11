package site.sorghum.loopra.bin.agent.core;

import lombok.extern.slf4j.Slf4j;
import site.sorghum.loopra.bin.agent.spi.SessionUsageSink;
import site.sorghum.loopra.integration.cutin.plugin.session.LoopraSessionAffinityHost;
import site.sorghum.loopra.integration.cutin.plugin.session.LoopraSessionHost;

import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * 会话生命周期宿主。
 * <p>负责 cutin 循环开始/结束时的断路器与中断标志重置，以及回合
 * 前后的 SessionUsageSink 回调（自动创建/落库会话）。</p>
 */
@Slf4j
final class SessionLifecycle implements LoopraSessionHost, LoopraSessionAffinityHost {

    private final Runnable beginLoop;
    private final Runnable endLoop;
    private final Supplier<SessionUsageSink> usageSink;
    private final Supplier<String> sessionId;
    private final Consumer<String> updateSessionId;

    SessionLifecycle(Runnable beginLoop, Runnable endLoop, Supplier<SessionUsageSink> usageSink,
                     Supplier<String> sessionId, Consumer<String> updateSessionId) {
        this.beginLoop = beginLoop;
        this.endLoop = endLoop;
        this.usageSink = usageSink;
        this.sessionId = sessionId;
        this.updateSessionId = updateSessionId;
    }

    @Override
    public void beginCutinLoop() {
        beginLoop.run();
    }

    @Override
    public void endCutinLoop() {
        endLoop.run();
    }

    @Override
    public String sessionAffinity() {
        return sessionId.get();
    }

    @Override
    public void afterTurn() {
        SessionUsageSink sink = usageSink.get();
        if (sink != null) {
            try {
                sink.afterTurn();
            } catch (Exception exception) {
                log.warn("[session] 回合提交回调失败: {}", exception.getMessage());
            }
        }
    }

    @Override
    public void beforeTurn(String userMessage) {
        SessionUsageSink sink = usageSink.get();
        if (userMessage.isBlank() || sink == null) {
            return;
        }
        try {
            String sessionId = sink.beforeTurn(userMessage);
            if (sessionId != null && !sessionId.isBlank()) {
                updateSessionId.accept(sessionId);
            }
        } catch (Exception exception) {
            log.warn("[session] 回合开始回调失败: {}", exception.getMessage());
        }
    }
}
