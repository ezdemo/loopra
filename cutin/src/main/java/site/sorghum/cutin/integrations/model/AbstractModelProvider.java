package site.sorghum.cutin.integrations.model;

import org.noear.snack4.ONode;
import site.sorghum.cutin.core.context.Message;
import site.sorghum.cutin.core.context.Usage;
import site.sorghum.cutin.core.json.JsonSupport;
import site.sorghum.cutin.core.model.ModelCapabilities;
import site.sorghum.cutin.core.model.ModelCallRequest;
import site.sorghum.cutin.core.model.ModelHttpExchange;
import site.sorghum.cutin.core.model.ModelProvider;
import site.sorghum.cutin.core.model.ModelResponse;
import site.sorghum.cutin.core.model.StreamChunk;
import site.sorghum.cutin.core.tool.ToolCall;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;

/**
 * HTTP/SSE 模型 Provider 基类：承载各协议 Provider 共用的配置、
 * 传输层、同步/流式调用骨架、请求头拦截、选项读取与流式累加器状态。
 *
 * <p>子类只需实现协议私有部分：请求体构建、同步响应解析、
 * SSE 增量解析与各协议的流式累加器。</p>
 */
abstract class AbstractModelProvider<A extends AbstractModelProvider.StreamAccumulator>
    implements ModelProvider {

    /** Provider 配置。 */
    protected final ModelProviderConfig config;
    /** HTTP 传输层。 */
    protected final HttpModelTransport transport;
    /** 发送前交由拦截器处理的基础请求头。 */
    private final Map<String, String> baseHeaders;

    /** 按配置与端点路径创建 Provider；baseHeaders 同时用于传输层与拦截器。 */
    protected AbstractModelProvider(
        ModelProviderConfig config,
        String endpointPath,
        Map<String, String> baseHeaders
    ) {
        this.config = config;
        this.baseHeaders = withUserAgent(config, baseHeaders);
        this.transport = new HttpModelTransport(config.endpoint(endpointPath), this.baseHeaders);
    }

    /**
     * 合并配置中的 {@code userAgent} 选项。不设置时保留 JDK/HTTP 客户端默认值；
     * 设置后覆盖 Java HttpClient 的 {@code Java-http-client} 标识。
     */
    private static Map<String, String> withUserAgent(
        ModelProviderConfig config,
        Map<String, String> baseHeaders
    ) {
        Object userAgent = config.options().get("userAgent");
        if (userAgent == null || String.valueOf(userAgent).isBlank()) {
            return baseHeaders;
        }
        Map<String, String> headers = new HashMap<>(baseHeaders);
        headers.put("User-Agent", String.valueOf(userAgent));
        return Map.copyOf(headers);
    }

    /** {@inheritDoc} */
    @Override
    public String id() {
        return config.id();
    }

    @Override
    public Map<String, Object> options() {
        return config.options();
    }

    /** {@inheritDoc} */
    @Override
    public ModelCapabilities capabilities() {
        return new ModelCapabilities(Set.of(config.model()), true, true);
    }

    /** 同步调用：构建请求体、经拦截器生成请求头后 POST，并附带原始请求与响应体。 */
    @Override
    public ModelResponse call(ModelCallRequest request) {
        ONode body = _buildBody(request, false);
        Map<String, String> headers = requestHeaders(request);
        String raw = transport.postRaw(body, headers);
        ONode response = JsonSupport.read(raw);
        return new ModelResponse(
            parseSyncMessage(response),
            parseSyncUsage(response),
            true,
            raw,
            transport.exchangeFor(body, headers)
        );
    }

    /** 从同步响应体中解析最终 assistant 消息。 */
    protected abstract Message parseSyncMessage(ONode response);

    /** 从同步响应体中解析用量；缺失时返回零用量。 */
    protected abstract Usage parseSyncUsage(ONode response);

    /** 流式调用：按 SSE 增量块转换为 StreamChunk，并在流尾聚合完整结果。 */
    @Override
    public Stream<StreamChunk> stream(ModelCallRequest request) {
        ONode body = _buildBody(request, true);
        Map<String, String> headers = requestHeaders(request);
        ModelHttpExchange exchange = transport.exchangeFor(body, headers);
        A accumulator = newAccumulator(exchange);
        Stream<StreamChunk> chunks = transport.postSse(body, headers)
            .map(chunk -> {
                String raw = chunk.toJson();
                accumulator.raw.append(raw).append('\n');
                return chunk;
            })
            .flatMap(chunk -> parseChunk(chunk, accumulator));
        return Stream.concat(chunks, Stream.of(accumulator).flatMap(StreamAccumulator::finalStream))
            .onClose(chunks::close);
    }

    /** 创建本协议的流式累加器。 */
    protected abstract A newAccumulator(ModelHttpExchange exchange);

    /** 把单个 SSE 事件转换为 StreamChunk，并按事件类型累加状态。 */
    protected abstract Stream<StreamChunk> parseChunk(ONode chunk, A accumulator);

    /** 取请求模型 id，为空时回退到配置中的默认模型。 */
    protected String model(ModelCallRequest request) {
        return request.modelId() == null || request.modelId().isBlank()
            ? config.model()
            : request.modelId();
    }

    /** 生成本次请求的最终请求头，保证会话级插件看到最新请求选项。 */
    @Override
    public Map<String, String> requestHeaders(ModelCallRequest request) {
        return ProviderInterceptor.runHeaders(this, model(request), request, baseHeaders);
    }

    /** 读取请求选项中的字符串值。 */
    protected String option(ModelCallRequest request, String key) {
        Object value = request.options().get(key);
        return value == null ? null : String.valueOf(value);
    }

    /** 取请求级推理力度，未设置时回退到配置。 */
    protected String reasoningEffort(ModelCallRequest request) {
        String value = option(request, "reasoningEffort");
        return value == null ? config.reasoningEffort() : value;
    }

    /** 解析 JSON 参数串；解析失败时返回空 Map。 */
    protected static Map<String, Object> parseArguments(String json) {
        try {
            return JsonSupport.parseObject(json);
        } catch (RuntimeException exception) {
            return Map.of();
        }
    }

    /** 序列化参数为 JSON 字符串；失败时返回空对象串。 */
    protected static String writeArguments(Map<String, Object> arguments) {
        try {
            return JsonSupport.write(arguments);
        } catch (RuntimeException exception) {
            return "{}";
        }
    }

    /**
     * 流式累加器共享状态：原始 SSE 数据、错误、用量、请求交换与推理开始标记。
     */
    protected abstract static class StreamAccumulator {

        /** 流中出现的错误原文。 */
        protected String error;
        /** 已累计或最近一次上报的用量，由各协议约定含义。 */
        protected Usage usage = Usage.ZERO;
        /** 全部原始 SSE 数据行。 */
        protected final StringBuilder raw = new StringBuilder();
        /** 本次请求的交换记录。 */
        protected final ModelHttpExchange exchange;
        /** 是否已发出本次响应的推理开始阶段。 */
        protected boolean reasoningStarted;

        protected StreamAccumulator(ModelHttpExchange exchange) {
            this.exchange = exchange;
        }

        /** 首个推理信号到达时返回 true，其后返回 false。 */
        protected boolean markReasoningStarted() {
            if (reasoningStarted) {
                return false;
            }
            reasoningStarted = true;
            return true;
        }

        /** 构造携带错误原文的终止块。 */
        protected StreamChunk errorChunk() {
            Map<String, Object> metadata = new HashMap<>();
            metadata.put("error", error);
            return new StreamChunk("", null, List.of(), List.of(), usage, metadata, true);
        }

        /** 流结束时输出聚合出的工具调用、思考块与未交付的用量。 */
        protected abstract Stream<StreamChunk> finalStream();
    }

    /** 单个流式工具调用的增量构建器。 */
    protected static class ToolCallBuilder {

        /** 工具调用 id。 */
        protected String id = "";
        /** 工具名称。 */
        protected String name = "";
        /** 参数 JSON 增量片段。 */
        protected StringBuilder arguments = new StringBuilder();

        /** 把累计片段解析为完整 ToolCall。 */
        protected ToolCall toToolCall() {
            return new ToolCall(id, name, parseArguments(arguments.toString()), id);
        }
    }
}
