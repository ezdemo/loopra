package site.sorghum.loopra.tool;

/** 与传输协议无关的 token 生成速率事件。 */
public record TokenSpeed(
        long completionTokens,
        double tokensPerSecond,
        double avgTokensPerSecond,
        boolean done) {
}
