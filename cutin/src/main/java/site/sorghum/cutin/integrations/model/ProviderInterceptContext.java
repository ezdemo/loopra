package site.sorghum.cutin.integrations.model;

import org.noear.snack4.ONode;
import site.sorghum.cutin.core.model.ModelCallRequest;
import site.sorghum.cutin.core.model.ModelProvider;

import java.util.Map;

/**
 * Provider 请求体拦截上下文。
 *
 * <p>携带实际执行请求的 {@link ModelProvider}（即"实际执行类"）、
 * 生效的模型 id（请求指定，空时回退到 Provider 默认模型）、原始请求与
 * 已构建的协议请求体，供拦截器检查或修改。请求头拦截阶段没有请求体，
 * 但会提供本次 ModelCallRequest（模型请求时）、Provider 选项
 * 和可变请求头。</p>
 */
public record ProviderInterceptContext(
    ModelProvider provider,
    String providerId,
    String modelId,
    ModelCallRequest request,
    ONode body,
    Map<String, Object> options,
    Map<String, String> headers
) {
    public ProviderInterceptContext {
        options = options == null ? Map.of() : options;
        headers = headers == null ? Map.of() : headers;
    }
}
