package site.sorghum.loopra.bin.agent.core;

import lombok.extern.slf4j.Slf4j;
import site.sorghum.loopra.bin.agent.spi.SessionUsageSink;
import site.sorghum.loopra.integration.cutin.plugin.session.LoopraSessionAffinityHost;
import site.sorghum.loopra.integration.cutin.plugin.session.LoopraSessionHost;

/**
 * 会话生命周期宿主。
 * <p>负责 cutin 循环开始/结束时的断路器与中断标志重置，以及回合
 * 前后的 SessionUsageSink 回调（自动创建/落库会话）。</p>
 */
@Slf4j
final class SessionLifecycle implements LoopraSessionHost, LoopraSessionAffinityHost {

    private final AgentLoop loop;

    SessionLifecycle(AgentLoop loop) {
        this.loop = loop;
    }

    @Override
    public void beginCutinLoop() {
        loop.stormBreaker().reset();
        loop.reasonBreaker().reset();
        loop.resetUserAbort();
    }

    @Override
    public void endCutinLoop() {
        loop.toolDispatcher().resetCutinSuppression();
    }

    @Override
    public String sessionAffinity() {
        return loop.getSessionId();
    }

    @Override
    public void afterTurn() {
        SessionUsageSink sink = loop.getSessionUsageSink();
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
        SessionUsageSink sink = loop.getSessionUsageSink();
        if (userMessage.isBlank() || sink == null) {
            return;
        }
        try {
            String sessionId = sink.beforeTurn(userMessage);
            if (sessionId != null && !sessionId.isBlank()) {
                loop.setSessionId(sessionId);
            }
        } catch (Exception exception) {
            log.warn("[session] 回合开始回调失败: {}", exception.getMessage());
        }
    }
}
