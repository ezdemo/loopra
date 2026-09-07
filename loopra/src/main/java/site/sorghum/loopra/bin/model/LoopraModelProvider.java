package site.sorghum.loopra.bin.model;

import lombok.Getter;
import lombok.Setter;
import org.noear.snack4.ONode;
import org.noear.solon.Solon;
import site.sorghum.cutin.core.model.ModelCallRequest;
import site.sorghum.cutin.core.model.ModelCapabilities;
import site.sorghum.cutin.core.model.ModelProvider;
import site.sorghum.cutin.core.model.ModelResponse;
import site.sorghum.cutin.core.model.StreamChunk;
import site.sorghum.cutin.integrations.model.*;
import site.sorghum.loopra.bin.agent.spi.AgentConfig;
import site.sorghum.loopra.bin.agent.model.ChatMessage;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Stream;

/**
 * Loopra 使用的 cutin 模型 Provider 宿主。
 *
 * <p>它不定义新的模型抽象，而是直接实现 cutin {@link ModelProvider}，
 * 负责按配置创建三个预置协议 Provider，并保留 Loopra 需要的有状态能力：
 * 模型热更新、快速模式、会话亲和、当前流取消与上下文窗口推断。</p>
 */
public class LoopraModelProvider implements ModelProvider {

    /** 当前请求的日志会话名，供 HTTP 传输层记录会话上下文。 */
    public static final ThreadLocal<String> CURRENT_LOG_SESSION = new ThreadLocal<>();

    @Getter
    @Setter
    private static volatile ContextSizeProvider contextSizeProvider;

    private final String apiUrl;
    private final String apiKey;
    private final String modelChannelId;
    private final String apiProtocol;
    private final String specialCompatibility;
    private volatile String model;
    private volatile String reasoningEffort;
    private volatile int maxTokens;
    private volatile boolean fastMode;
    private volatile String sessionAffinity;
    private volatile ModelProvider provider;
    private volatile Stream<StreamChunk> activeStream;
    private final AtomicBoolean abortRequested = new AtomicBoolean(false);

    public LoopraModelProvider(String apiUrl, String apiKey, String model) {
        this(apiUrl, apiKey, model, "high");
    }

    public LoopraModelProvider(String apiUrl, String apiKey, String model, String reasoningEffort) {
        this(apiUrl, apiKey, model, reasoningEffort, null);
    }

    public LoopraModelProvider(String apiUrl, String apiKey, String model, String reasoningEffort,
                               String modelChannelId) {
        this(apiUrl, apiKey, model, reasoningEffort, modelChannelId, "chat_completions");
    }

    public LoopraModelProvider(String apiUrl, String apiKey, String model, String reasoningEffort,
                               String modelChannelId, String apiProtocol) {
        this(apiUrl, apiKey, model, reasoningEffort, modelChannelId, apiProtocol, "",
                AgentConfig.DEFAULT_MAX_TOKENS);
    }

    public LoopraModelProvider(String apiUrl, String apiKey, String model, String reasoningEffort,
                               String modelChannelId, String apiProtocol, String specialCompatibility,
                               int maxTokens) {
        this.apiUrl = apiUrl;
        this.apiKey = apiKey;
        this.model = model;
        this.reasoningEffort = reasoningEffort;
        this.maxTokens = maxTokens > 0
                ? maxTokens : AgentConfig.DEFAULT_MAX_TOKENS;
        this.modelChannelId = modelChannelId;
        this.apiProtocol = normalizeApiProtocol(apiProtocol);
        this.specialCompatibility = normalizeSpecialCompatibility(specialCompatibility);
    }

    /** 创建短超时、零重试、带完整渠道配置的校验 Provider。 */
    public static LoopraModelProvider forValidation(String apiUrl, String apiKey, String model,
                                                    String modelChannelId, String apiProtocol,
                                                    String specialCompatibility, int maxTokens) {
        return new LoopraModelProvider(apiUrl, apiKey, model, "none", modelChannelId, apiProtocol,
                specialCompatibility, maxTokens);
    }

    /** 当前模型服务的请求地址。 */
    public String apiUrl() {
        return apiUrl;
    }

    /** 当前 Provider 使用的 cutin 协议 Provider。 */
    public ModelProvider provider() {
        ModelProvider current = provider;
        if (current != null) {
            return current;
        }
        synchronized (this) {
            current = provider;
            if (current == null) {
                current = createProvider();
                provider = current;
            }
            return current;
        }
    }

    @Override
    public String id() {
        return "loopra:" + modelChannelId + ":" + effectiveModel();
    }

    @Override
    public ModelResponse call(ModelCallRequest request) {
        return provider().call(prepareRequest(request));
    }

    @Override
    public Stream<StreamChunk> stream(ModelCallRequest request) {
        Stream<StreamChunk> raw = provider().stream(prepareRequest(request));
        AtomicReference<Stream<StreamChunk>> trackedRef = new AtomicReference<>();
        Stream<StreamChunk> tracked = raw.onClose(() -> {
            if (trackedRef.get() == activeStream) {
                activeStream = null;
            }
        });
        trackedRef.set(tracked);
        activeStream = tracked;
        return tracked;
    }

    /**
     * {@inheritDoc} 委托底层协议 Provider 构建最终请求体。
     */
    @Override
    public ONode buildBody(ModelCallRequest request, boolean stream) {
        return provider()._buildBody(prepareRequest(request), stream);
    }

    @Override
    public Map<String, String> requestHeaders(ModelCallRequest request) {
        return provider().requestHeaders(prepareRequest(request));
    }

    @Override
    public ModelCapabilities capabilities() {
        return new ModelCapabilities(Set.of(effectiveModel()), true, true);
    }

    /** 返回带上下文大小后缀的展示模型名。 */
    public String getModel() {
        return model;
    }

    /** 返回去掉上下文大小后缀后真正发给 Provider 的模型名。 */
    public String effectiveModel() {
        return ModelContextUtils.stripContextSizeSuffix(model);
    }

    public String getModelChannelId() {
        return modelChannelId;
    }

    /** 返回当前请求使用的思考强度。 */
    public String getReasoningEffort() {
        return reasoningEffort;
    }

    /** 返回当前请求使用的最大输出 token 数。 */
    public int getMaxTokens() {
        return maxTokens;
    }

    /** 返回当前渠道选择的特殊兼容插件 ID。 */
    public String getSpecialCompatibility() {
        return specialCompatibility;
    }

    /** 运行时切换模型；模型变化后重建底层 Provider。 */
    public void setModel(String model) {
        synchronized (this) {
            this.model = model;
            provider = null;
        }
    }

    /** 运行时切换推理力度；变化后重建底层 Provider。 */
    public void setReasoningEffort(String reasoningEffort) {
        synchronized (this) {
            this.reasoningEffort = reasoningEffort;
            provider = null;
        }
    }

    /** 运行时切换最大输出 token 数；变化后重建底层 Provider。 */
    public void setMaxTokens(int maxTokens) {
        synchronized (this) {
            this.maxTokens = maxTokens > 0
                    ? maxTokens : AgentConfig.DEFAULT_MAX_TOKENS;
            provider = null;
        }
    }

    /** 运行时切换快速模式；变化后重建底层 Provider。 */
    public void setFastMode(boolean fastMode) {
        synchronized (this) {
            this.fastMode = fastMode;
            provider = null;
        }
    }

    /** 固定请求级会话亲和标识，用于 prompt cache key。 */
    public void setSessionAffinity(String sessionAffinity) {
        this.sessionAffinity = sessionAffinity;
    }

    /** 中断当前正在进行的流式调用。 */
    public void abortStream() {
        abortRequested.set(true);
        Stream<StreamChunk> stream = activeStream;
        if (stream != null) {
            stream.close();
        }
    }

    /** 清除上一轮遗留的流式中断状态。 */
    public void resetStreamAbort() {
        abortRequested.set(false);
    }

    /** 复制一个可独立流式调用和中断的 Provider 实例。 */
    public LoopraModelProvider fork() {
        LoopraModelProvider fork = new LoopraModelProvider(
            apiUrl,
            apiKey,
            model,
            reasoningEffort,
            modelChannelId,
            apiProtocol,
            specialCompatibility,
            maxTokens
        );
        fork.setSessionAffinity(sessionAffinity);
        fork.setFastMode(fastMode);
        return fork;
    }

    /** 模型最大上下文窗口 token 数，用于折叠阈值计算。 */
    public int getMaxContextTokens() {
        String env = System.getenv("LOOPRA_MAX_CONTEXT_TOKENS");
        if (env != null && !env.isEmpty()) {
            try {
                return Integer.parseInt(env);
            } catch (NumberFormatException ignored) {
                // 环境变量格式错误时继续使用其他推断方式
            }
        }
        if (model == null) {
            return 200_000;
        }
        int suffixSize = ModelContextUtils.parseContextSizeSuffix(model);
        if (suffixSize > 0) {
            return suffixSize;
        }
        if (contextSizeProvider != null) {
            int providerSize = contextSizeProvider.getContextSize(modelChannelId, model);
            if (providerSize > 0) {
                return providerSize;
            }
        }
        return 256_000;
    }

    /** 为后台非流式调用构建可直接发给 cutin Provider 的请求。 */
    public ModelCallRequest buildRequest(List<ChatMessage> messages, ONode tools) {
        return new ModelCallRequest(
            effectiveModel(),
            CutinModelMessages.toCutin(messages),
            CutinModelTools.toCutin(tools),
            Map.of()
        );
    }

    /** 把 Loopra 运行期参数合并进请求，请求中已有的值优先。 */
    public ModelCallRequest prepareRequest(ModelCallRequest request) {
        Map<String, Object> options = new HashMap<>(request.options());
        options.putIfAbsent("reasoningEffort", reasoningEffort);
        if (fastMode) {
            options.putIfAbsent("serviceTier", "fast");
        }
        String affinity = resolveSessionAffinity(request);
        if (affinity != null && !affinity.isBlank()) {
            // 用 put 而非 putIfAbsent：子代理显式亲和必须覆盖 AgentLoop 注入的会话级值
            options.put("sessionAffinity", affinity);
        }
        options.putIfAbsent("userId", site.sorghum.loopra.bin.util.UserIdProvider.getUserId());
        return new ModelCallRequest(request.modelId(), request.messages(), request.tools(), options);
    }
    
    /**
     * 解析会话亲和标识，优先级：显式设置（子代理）> 请求携带值（AgentLoop 注入的会话 ID）>
     * 当前日志会话名（旧版 ThreadLocal 回退，仅部分入口设置）。
     */
    private String resolveSessionAffinity(ModelCallRequest request) {
        if (sessionAffinity != null && !sessionAffinity.isBlank()) {
            return sessionAffinity;
        }
        Object fromRequest = request.options().get("sessionAffinity");
        if (fromRequest != null && !String.valueOf(fromRequest).isBlank()) {
            return String.valueOf(fromRequest);
        }
        return CURRENT_LOG_SESSION.get();
    }

    private ModelProvider createProvider() {
        String effectiveModel = effectiveModel();
        Map<String, Object> options = new HashMap<>();
        options.put("reasoningEffort", reasoningEffort);
        options.put("endpoint", apiUrl);
        if (fastMode) {
            options.put("serviceTier", "fast");
        }
        options.put("maxTokens", maxTokens);
        options.put("specialCompatibility", specialCompatibility);
        options.put("fallbackSessionId", id());
        ModelProviderConfig config = new ModelProviderConfig(
            id(),
            apiUrl,
            apiKey,
            effectiveModel,
            options
        );
        if ("responses".equalsIgnoreCase(apiProtocol)) {
            return new OpenAiResponsesProvider(config);
        }
        if ("anthropic".equalsIgnoreCase(apiProtocol)) {
            return new AnthropicMessagesProvider(config);
        }
        return new OpenAiChatCompletionsProvider(config);
    }

    private static String normalizeApiProtocol(String value) {
        String normalized = value == null ? "" : value.trim().toLowerCase(java.util.Locale.ROOT);
        if ("responses".equals(normalized)) return "responses";
        if ("anthropic".equals(normalized)) return "anthropic";
        return "chat_completions";
    }

    private static String normalizeSpecialCompatibility(String value) {
        String normalized = value == null ? "" : value.trim().toLowerCase(java.util.Locale.ROOT);
        return normalized;
    }

}
