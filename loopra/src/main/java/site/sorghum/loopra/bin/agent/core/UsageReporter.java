package site.sorghum.loopra.bin.agent.core;

import lombok.extern.slf4j.Slf4j;
import site.sorghum.cutin.core.context.Usage;
import site.sorghum.loopra.bin.agent.listener.AgentLoopListener;
import site.sorghum.loopra.bin.agent.spi.SessionUsageSink;
import site.sorghum.loopra.integration.cutin.plugin.usage.LoopraTokenSpeedHost;
import site.sorghum.loopra.integration.cutin.plugin.usage.LoopraUsageHost;
import site.sorghum.loopra.tool.AgentOutput;
import site.sorghum.loopra.tool.TokenSpeed;

import java.util.function.IntConsumer;
import java.util.function.Supplier;

/**
 * 用量上报与 token 速率推送宿主。
 * <p>cutin 路径下的用量统一从这里出口，
 * 否则会话的 lastPromptTokens / 上下文长度展示和用量统计不会更新。</p>
 */
@Slf4j
final class UsageReporter implements LoopraUsageHost, LoopraTokenSpeedHost {

    private final IntConsumer recordPromptTokens;
    private final Supplier<SessionUsageSink> usageSink;
    private final Supplier<String> model;
    private final Supplier<AgentLoopListener> listener;
    private final Supplier<AgentOutput> output;

    UsageReporter(IntConsumer recordPromptTokens, Supplier<SessionUsageSink> usageSink,
                  Supplier<String> model, Supplier<AgentLoopListener> listener,
                  Supplier<AgentOutput> output) {
        this.recordPromptTokens = recordPromptTokens;
        this.usageSink = usageSink;
        this.model = model;
        this.listener = listener;
        this.output = output;
    }

    @Override
    public void reportCutinUsage(Usage usage) {
        int promptTokens = Math.toIntExact(usage.promptTokens());
        int completionTokens = Math.toIntExact(usage.completionTokens());
        int totalTokens = promptTokens + completionTokens;
        int cacheHit = Math.toIntExact(usage.cacheReadTokens());
        int cacheMiss = Math.toIntExact(usage.cacheMissTokens());
        recordPromptTokens.accept(promptTokens);
        SessionUsageSink sessionUsageSink = usageSink.get();
        if (sessionUsageSink != null) {
            sessionUsageSink.updateLastPromptTokens(promptTokens);
        }
        String currentModel = model.get();
        try {
            listener.get().onUsage(currentModel, promptTokens, completionTokens, totalTokens, cacheHit, cacheMiss);
        } catch (Exception exception) {
            log.warn("[usage] listener异常: {}", exception.getMessage());
        }
        try {
            output.get().onUsage(currentModel, promptTokens, completionTokens, totalTokens, cacheHit, cacheMiss);
        } catch (Exception exception) {
            log.debug("[usage] output异常: {}", exception.getMessage());
        }
    }

    @Override
    public void emitTokenSpeed(long completionTokens, double tokensPerSecond, double avgTokensPerSecond, boolean done) {
        try {
            output.get().onTokenSpeed(new TokenSpeed(completionTokens, tokensPerSecond, avgTokensPerSecond, done));
        } catch (Exception exception) {
            log.debug("[tokenSpeed] output异常: {}", exception.getMessage());
        }
    }
}
