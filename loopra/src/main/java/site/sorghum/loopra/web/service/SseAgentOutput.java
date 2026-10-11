package site.sorghum.loopra.web.service;

import org.noear.snack4.ONode;
import site.sorghum.loopra.tool.AgentOutput;
import site.sorghum.loopra.tool.ChoiceOption;
import site.sorghum.loopra.tool.LogLevel;
import site.sorghum.loopra.tool.TokenSpeed;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * SSE 桥接的 AgentOutput 实现 —— 将 Agent 事件转发到 SseEmitter。
 * 替代 AgentService 中的匿名 AgentOutput。
 *
 * @author Sorghum
 */
public class SseAgentOutput implements AgentOutput {

    private final SseEmitter emitter;

    public SseAgentOutput(SseEmitter emitter) {
        this.emitter = emitter;
    }

    @Override
    public void onContentDelta(String token) {
        emitter.sendContent(token);
    }

    @Override
    public void onContentComplete() {
    }

    @Override
    public void onReasoningDelta(String token) {
        emitter.sendReasoning(token);
    }

    @Override
    public void onReasoning(String reasoning) {
        if (reasoning != null && !reasoning.isEmpty()) {
            emitter.sendReasoning(reasoning);
        }
    }

    @Override
    public void onReasoningStarted() {
        emitter.sendReasoningStarted();
    }

    @Override
    public void onToolCall(String name, String args) {
        emitter.sendToolCall(name, args);
    }

    @Override
    public void onToolResult(String name, String result) {
        emitter.sendToolResult(name, result);
    }

    @Override
    public void onUsage(int promptTokens, int completionTokens, int totalTokens,
                        int cacheHit, int cacheMiss) {
        emitter.sendUsage(promptTokens, completionTokens, totalTokens, cacheHit, cacheMiss);
    }

    @Override
    public void onUsage(String model, int promptTokens, int completionTokens, int totalTokens,
                        int cacheHit, int cacheMiss) {
        emitter.sendUsage(promptTokens, completionTokens, totalTokens, cacheHit, cacheMiss);
    }

    @Override
    public void onTokenSpeed(TokenSpeed speed) {
        emitter.sendTokenSpeed(speed.completionTokens(), speed.tokensPerSecond(), speed.avgTokensPerSecond(), speed.done());
    }

    public void onTokenSpeed(long completionTokens, double tokensPerSecond, double avgTokensPerSecond, boolean done) {
        emitter.sendTokenSpeed(completionTokens, tokensPerSecond, avgTokensPerSecond, done);
    }

    public void onTokenSpeed(long completionTokens, double tokensPerSecond, boolean done) {
        emitter.sendTokenSpeed(completionTokens, tokensPerSecond, done);
    }

    @Override
    public void onError(String error) {
        emitter.sendError(error);
    }

    @Override
    public void onLog(LogLevel level, String message) {
        emitter.send("log", ONode.serialize(Map.of("level", level.name(), "message", message)));
    }

    @Override
    public void onChoice(List<ChoiceOption> options) {
        if (options != null && !options.isEmpty()) {
            emitter.sendChoice(new ArrayList<>(options));
        }
    }

    @Override
    public void onChoice(List<ChoiceOption> options, String title, String description) {
        if (options != null && !options.isEmpty()) {
            emitter.sendChoice(title, description, new ArrayList<>(options));
        }
    }

    @Override
    public void sendEvent(String type, String data) {
        if (type != null && data != null) {
            emitter.send(type, data);
        }
    }
}
