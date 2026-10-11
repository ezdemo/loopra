package site.sorghum.loopra.bin.agent.core;

import lombok.extern.slf4j.Slf4j;
import site.sorghum.cutin.core.context.Usage;
import site.sorghum.loopra.bin.agent.listener.AgentLoopListener;
import site.sorghum.loopra.bin.agent.spi.SessionUsageSink;
import site.sorghum.loopra.integration.cutin.plugin.usage.LoopraTokenSpeedHost;
import site.sorghum.loopra.integration.cutin.plugin.usage.LoopraUsageHost;
import site.sorghum.loopra.tool.AgentOutput;
import site.sorghum.loopra.web.service.SseAgentOutput;

/**
 * 用量上报与 token 速率推送宿主。
 * <p>cutin 路径下的用量统一从这里出口，
 * 否则会话的 lastPromptTokens / 上下文长度展示和用量统计不会更新。</p>
 */
@Slf4j
final class UsageReporter implements LoopraUsageHost, LoopraTokenSpeedHost {

    private final AgentLoop loop;

    UsageReporter(AgentLoop loop) {
        this.loop = loop;
    }

    @Override
    public void reportCutinUsage(Usage usage) {
        int promptTokens = Math.toIntExact(usage.promptTokens());
        int completionTokens = Math.toIntExact(usage.completionTokens());
        int totalTokens = promptTokens + completionTokens;
        int cacheHit = Math.toIntExact(usage.cacheReadTokens());
        int cacheMiss = Math.toIntExact(usage.cacheMissTokens());
        loop.lastPromptTokens(promptTokens);
        SessionUsageSink sessionUsageSink = loop.getSessionUsageSink();
        if (sessionUsageSink != null) {
            sessionUsageSink.updateLastPromptTokens(promptTokens);
        }
        String currentModel = loop.getModelProvider().getModel();
        AgentLoopListener listener = loop.listener();
        AgentOutput output = loop.getOutput();
        loop.safeListener("usage", () -> listener.onUsage(
                currentModel, promptTokens, completionTokens, totalTokens, cacheHit, cacheMiss));
        loop.safeOutputDebug("usage", () -> output.onUsage(
                currentModel, promptTokens, completionTokens, totalTokens, cacheHit, cacheMiss));
    }

    @Override
    public void emitTokenSpeed(long completionTokens, double tokensPerSecond, double avgTokensPerSecond, boolean done) {
        loop.safeOutputDebug("tokenSpeed", () -> {
            AgentOutput output = loop.getOutput();
            if (output instanceof SseAgentOutput sse) {
                sse.onTokenSpeed(completionTokens, tokensPerSecond, avgTokensPerSecond, done);
            } else {
                output.sendEvent("token_speed", "{\"completionTokens\":" + completionTokens + ",\"tokensPerSecond\":" + tokensPerSecond + ",\"avgTokensPerSecond\":" + avgTokensPerSecond + ",\"done\":" + done + "}");
            }
        });
    }
}
