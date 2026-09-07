package site.sorghum.cutin.integrations.model;

import org.noear.snack4.ONode;
import site.sorghum.cutin.core.model.ModelProvider;

/**
 * 通用最大输出 token 插件。
 *
 * <p>协议 Provider 只负责构建消息、工具等基础结构；最大输出 token 的
 * 协议字段映射统一在拦截器中完成：Chat/Anthropic 使用 {@code max_tokens}，
 * Responses 使用 {@code max_output_tokens}。</p>
 */
public final class MaxOutputTokensInterceptor implements ProviderInterceptor {

    private static final int DEFAULT_CHAT_TOKENS = 32768;
    private static final int DEFAULT_ANTHROPIC_TOKENS = 8192;

    @Override
    public ONode intercept(ProviderInterceptContext context) {
        ModelProvider provider = context.provider();
        int maxTokens = positiveNumber(context.request().options().get("maxTokens"));
        if (maxTokens <= 0) {
            maxTokens = positiveNumber(provider.options().get("maxTokens"));
        }
        if (maxTokens <= 0) {
            maxTokens = defaultMaxTokens(provider);
        }
        if (maxTokens <= 0) {
            return null;
        }

        if (provider instanceof OpenAiResponsesProvider) {
            context.body().set("max_output_tokens", maxTokens);
        } else if (provider instanceof OpenAiChatCompletionsProvider
                || provider instanceof AnthropicMessagesProvider) {
            context.body().set("max_tokens", maxTokens);
        }
        return context.body();
    }

    private static int defaultMaxTokens(ModelProvider provider) {
        if (provider instanceof AnthropicMessagesProvider) {
            return DEFAULT_ANTHROPIC_TOKENS;
        }
        if (provider instanceof OpenAiChatCompletionsProvider
                || provider instanceof OpenAiResponsesProvider) {
            return DEFAULT_CHAT_TOKENS;
        }
        return 0;
    }

    private static int positiveNumber(Object value) {
        if (value instanceof Number number && number.intValue() > 0) {
            return number.intValue();
        }
        if (value == null) {
            return 0;
        }
        try {
            int parsed = Integer.parseInt(String.valueOf(value));
            return parsed > 0 ? parsed : 0;
        } catch (NumberFormatException ignored) {
            return 0;
        }
    }
}
