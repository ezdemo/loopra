package site.sorghum.cutin.integrations.model;

import org.noear.snack4.ONode;
import site.sorghum.cutin.core.model.ModelCallRequest;
import site.sorghum.cutin.core.model.ModelProvider;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Provider 请求拦截器：可以在每次请求发送前拦截请求头，
 * 也可以在请求体构建完成后修改协议请求体。
 *
 * <p>通过 {@link #register(ProviderInterceptor)} 注册到全局拦截链，
 * 同步与流式调用都会生效（所有 {@link ModelProvider} 的 {@code _buildBody}
 * 都会先执行拦截链再发送）。拦截器可以就地修改传入的 body，也可以返回
 * 一个新的 {@link ONode} 整体替换最终请求体；返回 {@code null} 表示就地
 * 修改、不替换。抛出异常会直接中断本次模型调用（在网关层走 ON_MODEL_ERROR）。</p>
 *
 * <p>注册的拦截器对所有 Provider、所有协议生效，因此拦截器需要自行按
 * {@code context.modelId()} 与 {@code context.provider()} 过滤目标；
 * body 是各协议私有的 JSON 结构（Chat Completions、Messages、Responses
 * 各不相同），headers 是本次请求最终发出的请求头，options 是 Provider 创建阶段
 * 与本次请求合并后的扩展选项。</p>
 */
@FunctionalInterface
public interface ProviderInterceptor {

    /** 全局拦截链（线程安全，按注册顺序执行）。 */
    List<ProviderInterceptor> INTERCEPT_LIST = new CopyOnWriteArrayList<>();
    /** 内置 Provider 选项插件只初始化一次。 */
    AtomicBoolean BUILT_INS_INITIALIZED = new AtomicBoolean();

    /** 拦截已构建的协议请求体，返回非 null 则替换，返回 null 表示就地修改、不替换。 */
    ONode intercept(ProviderInterceptContext context);

    /**
     * 拦截每次 Provider 请求发送前的请求头。
     *
     * <p>默认不修改。请求头拦截器直接修改
     * {@link ProviderInterceptContext#headers()}，与 Deepseek 等请求体拦截器
     * 使用同一个插件注册机制。请求体 Provider 的同步调用和流式调用都会执行；
     * 模型列表探测等没有实际请求体的调用中 {@link ProviderInterceptContext#request()}
     * 可能为 {@code null}。</p>
     */
    default void interceptHeaders(ProviderInterceptContext context) {
        // 默认不修改请求头
    }

    /** 注册拦截器到全局链；重复注册同一实例会被忽略。 */
    static void register(ProviderInterceptor interceptor) {
        if (interceptor == null) {
            return;
        }
        if (!INTERCEPT_LIST.contains(interceptor)) {
            INTERCEPT_LIST.add(interceptor);
        }
    }

    /** 从全局链移除拦截器，返回是否确实移除了某个实例。 */
    static boolean unregister(ProviderInterceptor interceptor) {
        return INTERCEPT_LIST.remove(interceptor);
    }

    /** 按注册顺序执行全局拦截链，返回最终请求体。 */
    static ONode run(
        ModelProvider provider,
        String modelId,
        ModelCallRequest request,
        ONode body
    ) {
        return run(INTERCEPT_LIST, provider, modelId, request, body);
    }

    /** 按顺序执行指定拦截链，返回最终请求体。 */
    static ONode run(
        List<ProviderInterceptor> interceptors,
        ModelProvider provider,
        String modelId,
        ModelCallRequest request,
        ONode body
    ) {
        ensureBuiltInInterceptors();
        ONode current = body;
        if (interceptors == null || interceptors.isEmpty()) {
            return current;
        }
        for (ProviderInterceptor interceptor : interceptors) {
            if (interceptor == null) {
                continue;
            }
            ONode next = interceptor.intercept(new ProviderInterceptContext(
                provider,
                provider.id(),
                modelId,
                request,
                current,
                provider.options(),
                Map.of()
            ));
            if (next != null) {
                current = next;
            }
        }
        return current;
    }

    /**
     * 按本次实际请求执行请求头拦截链。请求选项会覆盖 Provider 创建时的同名选项，
     * 这样会话级路由等动态值不会被 Provider 缓存时的旧值覆盖。
     */
    static Map<String, String> runHeaders(
        ModelProvider provider,
        String modelId,
        ModelCallRequest request,
        Map<String, String> headers
    ) {
        Map<String, Object> options = new LinkedHashMap<>();
        if (provider != null && provider.options() != null) {
            options.putAll(provider.options());
        }
        if (request != null && request.options() != null) {
            options.putAll(request.options());
        }
        return runHeaders(
            INTERCEPT_LIST,
            provider,
            provider == null ? null : provider.id(),
            modelId,
            request,
            options,
            headers
        );
    }

    /**
     * 为没有具体 Provider 实例的请求（例如模型列表探测）执行请求头拦截链。
     */
    static Map<String, String> runHeaders(
        String providerId,
        String modelId,
        Map<String, Object> options,
        Map<String, String> headers
    ) {
        return runHeaders(INTERCEPT_LIST, null, providerId, modelId, null, options, headers);
    }

    /** 按顺序执行指定请求头拦截链，并携带实际请求。 */
    static Map<String, String> runHeaders(
        List<ProviderInterceptor> interceptors,
        ModelProvider provider,
        String providerId,
        String modelId,
        ModelCallRequest request,
        Map<String, Object> options,
        Map<String, String> headers
    ) {
        ensureBuiltInInterceptors();
        Map<String, String> current = new LinkedHashMap<>();
        if (headers != null) {
            current.putAll(headers);
        }
        Map<String, Object> providerOptions = options == null ? Map.of() : options;
        ProviderInterceptContext context = new ProviderInterceptContext(
            provider,
            providerId,
            modelId,
            request,
            null,
            providerOptions,
            current
        );
        if (interceptors != null) {
            for (ProviderInterceptor interceptor : interceptors) {
                if (interceptor != null) {
                    interceptor.interceptHeaders(context);
                }
            }
        }
        return Map.copyOf(current);
    }

    /** 注册 cutin 自带的通用请求插件；业务模块可继续注册自己的插件。 */
    static void ensureBuiltInInterceptors() {
        if (BUILT_INS_INITIALIZED.compareAndSet(false, true)) {
            register(new MaxOutputTokensInterceptor());
        }
    }
}
