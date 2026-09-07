package site.sorghum.cutin.integrations.model;

import org.noear.snack4.ONode;
import site.sorghum.cutin.core.context.Message;
import site.sorghum.cutin.core.context.Usage;
import site.sorghum.cutin.core.json.JsonSupport;
import site.sorghum.cutin.core.model.*;
import site.sorghum.cutin.core.tool.ToolCall;
import site.sorghum.cutin.core.tool.ToolDefinition;

import java.util.*;
import java.util.stream.Stream;

/**
 * OpenAI Chat Completions 协议 Provider（/chat/completions）。
 *
 * <p>支持同步调用、SSE 流式调用、工具调用、推理内容与用量统计；
 * 流式工具调用通过按 index 累加增量片段的方式还原完整参数。</p>
 */
public final class OpenAiChatCompletionsProvider implements ModelProvider {

    /** Provider 配置。 */
    private final ModelProviderConfig config;
    /** HTTP 传输层。 */
    private final HttpModelTransport transport;

    /** 按配置创建 Provider，endpoint 指向 /chat/completions；请求头在发送前由拦截器生成。 */
    public OpenAiChatCompletionsProvider(ModelProviderConfig config) {
        this.config = config;
        this.transport = new HttpModelTransport(
            config.endpoint("/chat/completions"),
            Map.of("Authorization", "Bearer " + config.apiKey())
        );
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

    /** 同步调用：POST 请求后解析消息、工具调用与用量，并附带原始请求与响应体。 */
    @Override
    public ModelResponse call(ModelCallRequest request) {
        ONode body = _buildBody(request, false);
        Map<String, String> headers = requestHeaders(request);
        String raw = transport.postRaw(body, headers);
        ONode response = JsonSupport.read(raw);
        Message message = parseMessage(JsonSupport.child(response, "choices", 0, "message"));
        Usage usage = parseResponseUsage(response);
        return new ModelResponse(message, usage, true, raw, transport.exchangeFor(body, headers));
    }

    /** 流式调用：解析 SSE 增量块，并在流尾追加聚合出的工具调用与用量。 */
    @Override
    public Stream<StreamChunk> stream(ModelCallRequest request) {
        ONode body = _buildBody(request, true);
        Map<String, String> headers = requestHeaders(request);
        site.sorghum.cutin.core.model.ModelHttpExchange exchange = transport.exchangeFor(body, headers);
        Accumulator accumulator = new Accumulator(exchange);
        Stream<StreamChunk> chunks = transport.postSse(body, headers)
            .map(chunk -> {
                String raw = chunk.toJson();
                accumulator.raw.append(raw).append('\n');
                return chunk;
            })
            .flatMap(chunk -> parseChunk(chunk, accumulator));
        return Stream.concat(chunks, Stream.of(accumulator).flatMap(Accumulator::finalStream))
            .onClose(chunks::close);
    }

    /** {@inheritDoc} */
    @Override
    public ModelCapabilities capabilities() {
        return new ModelCapabilities(Set.of(config.model()), true, true);
    }

    /** {@inheritDoc} 构建 Chat Completions 请求体：模型、流标记、消息、工具与扩展选项。 */
    @Override
    public ONode buildBody(ModelCallRequest request, boolean stream) {
        ONode body = JsonSupport.object();
        String model = model(request);
        body.set("model", model);
        body.set("stream", stream);

        String serviceTier = option(request, "serviceTier");
        if (serviceTier != null && !serviceTier.isBlank()) {
            body.set("service_tier", serviceTier);
        }
        String reasoningEffort = reasoningEffort(request);
        if (reasoningEffort != null && !reasoningEffort.isBlank() && !"none".equals(reasoningEffort)) {
            body.set("reasoning_effort", reasoningEffort);
        }
        ONode messages = JsonSupport.array();
        body.set("messages", messages);
        for (Message message : request.messages()) {
            messages.add(toOpenAiMessage(message));
        }

        addTools(body, request.tools());
        String userId = option(request, "userId");
        if (userId != null && !userId.isBlank()) {
            body.set("user", userId);
        }
        String sessionAffinity = option(request, "sessionAffinity");
        if (sessionAffinity != null && !sessionAffinity.isBlank()) {
            body.set("prompt_cache_key", sessionAffinity);
        }
        return body;
    }

    /** 把通用 Message 转换为 OpenAI 消息格式（含 tool_calls 与 reasoning_content）。 */
    private ONode toOpenAiMessage(Message message) {
        ONode node = JsonSupport.object();
        node.set("role", message.role());
        if (message.toolCallId() != null) {
            node.set("tool_call_id", message.toolCallId());
        }
        if ("tool".equals(message.role())
            && (message.content() == null || message.content().isEmpty())) {
            node.set("content", "ERROR tool execution failed or returned empty");
        } else if (message.metadata("images") instanceof List<?> images && !images.isEmpty()) {
            ONode content = JsonSupport.array();
            if (message.content() != null && !message.content().isEmpty()) {
                ONode text = JsonSupport.object();
                text.set("type", "text");
                text.set("text", message.content());
                content.add(text);
            }
            for (Object image : images) {
                ONode part = JsonSupport.object();
                part.set("type", "image_url");
                ONode imageUrl = JsonSupport.object();
                imageUrl.set("url", String.valueOf(image));
                part.set("image_url", imageUrl);
                content.add(part);
            }
            node.set("content", content);
        } else if (message.content() != null) {
            node.set("content", message.content());
        }
        Object reasoning = message.metadata("reasoning_content");
        if (reasoning != null) {
            node.set("reasoning_content", String.valueOf(reasoning));
        }
        if (message.hasToolCalls()) {
            ONode toolCalls = JsonSupport.array();
            node.set("tool_calls", toolCalls);
            for (ToolCall toolCall : message.toolCalls()) {
                ONode call = JsonSupport.object();
                toolCalls.add(call);
                call.set("id", toolCall.id());
                call.set("type", "function");
                ONode function = JsonSupport.object();
                call.set("function", function);
                function.set("name", toolCall.toolId());
                function.set("arguments", writeArguments(toolCall.arguments()));
            }
        }
        return node;
    }

    /** 把工具定义转换为 OpenAI function 声明。 */
    private void addTools(ONode body, List<ToolDefinition> tools) {
        if (tools == null || tools.isEmpty()) {
            return;
        }
        ONode node = JsonSupport.array();
        body.set("tools", node);
        for (ToolDefinition tool : tools) {
            ONode entry = JsonSupport.object();
            node.add(entry);
            entry.set("type", "function");
            ONode function = JsonSupport.object();
            entry.set("function", function);
            function.set("name", tool.id());
            function.set("description", tool.description());
            function.set("parameters", JsonSupport.bean(tool.inputSchema()));
        }
    }

    /** 解析响应的 assistant 消息，包括正文、推理与工具调用。 */
    private Message parseMessage(ONode message) {
        String content = JsonSupport.text(message, "", "content");
        String reasoning = JsonSupport.text(message, null, "reasoning_content");
        Map<String, Object> metadata = new HashMap<>();
        if (reasoning != null && !reasoning.isEmpty()) {
            metadata.put("reasoning_content", reasoning);
        }
        return new Message(
            "assistant",
            content,
            null,
            parseToolCalls(JsonSupport.child(message, "tool_calls")),
            metadata
        );
    }

    /** 解析工具调用数组为 ToolCall 列表。 */
    private List<ToolCall> parseToolCalls(ONode toolCalls) {
        if (toolCalls == null || toolCalls.isNull() || !toolCalls.isArray()) {
            return List.of();
        }
        List<ToolCall> calls = new ArrayList<>();
        for (ONode call : toolCalls.getArray()) {
            String callId = JsonSupport.text(call, "", "id");
            String name = JsonSupport.text(call, "", "function", "name");
            String argumentsJson = JsonSupport.text(call, "{}", "function", "arguments");
            calls.add(new ToolCall(callId, name, parseArguments(argumentsJson), callId));
        }
        return calls;
    }

    /** 解析用量节点；缺失时返回零用量。 */
    private Usage parseUsage(ONode usage) {
        if (usage == null || usage.isNull()) {
            return Usage.ZERO;
        }
        long promptTokens = JsonSupport.longValue(usage, 0, "prompt_tokens");
        long cacheRead = JsonSupport.longValue(usage, 0, "prompt_tokens_details", "cached_tokens");
        if (cacheRead == 0) {
            // DeepSeek 等兼容协议使用顶层字段上报缓存命中
            cacheRead = JsonSupport.longValue(usage, 0, "prompt_cache_hit_tokens");
        }
        return new Usage(
            promptTokens,
            JsonSupport.longValue(usage, 0, "completion_tokens"),
            JsonSupport.longValue(usage, 0, "cost_micros"),
            cacheRead,
            0
        );
    }

    /** 兼容标准 OpenAI、llama.cpp timings 与 Ollama 原生计数字段。 */
    private Usage parseResponseUsage(ONode response) {
        ONode usage = JsonSupport.child(response, "usage");
        if (usage != null && !usage.isNull()) {
            Usage standard = parseUsage(usage);
            if (standard.totalTokens() > 0 || standard.costMicros() > 0) {
                return standard;
            }
        }
        ONode timings = JsonSupport.child(response, "timings");
        if (timings != null && !timings.isNull()) {
            long cacheRead = JsonSupport.longValue(timings, 0, "cache_n");
            long promptProcessed = JsonSupport.longValue(timings, 0, "prompt_n");
            Usage llamaCpp = new Usage(
                cacheRead + promptProcessed,
                JsonSupport.longValue(timings, 0, "predicted_n"),
                0,
                cacheRead,
                0
            );
            if (llamaCpp.totalTokens() > 0) {
                return llamaCpp;
            }
        }

        // Ollama /api/chat 与 /api/generate 在最终响应顶层上报这两个字段。
        return new Usage(
            JsonSupport.longValue(response, 0, "prompt_eval_count"),
            JsonSupport.longValue(response, 0, "eval_count"),
            0,
            0,
            0
        );
    }

    /** 把单个 SSE 增量块转换为若干 StreamChunk，并累计工具调用、记录最新用量。 */
    private Stream<StreamChunk> parseChunk(ONode chunk, Accumulator state) {
        Stream.Builder<StreamChunk> builder = Stream.builder();
        ONode error = JsonSupport.child(chunk, "error");
        if (error != null && !error.isNull()) {
            state.error = chunk.toJson();
            builder.add(state.errorChunk());
            return builder.build();
        }

        ONode usage = JsonSupport.child(chunk, "usage");
        if (usage != null && !usage.isNull()) {
            // OpenAI 兼容流中的 usage 是截至当前块的累计值（规范只在末块出现一次，
            // OpenRouter 等网关会逐块携带同一累计值）。这里只取最新值并在流尾统一
            // 交付一次，不能逐块累加，否则 prompt_tokens 会随流块数量成倍放大。
            state.usage = parseUsage(usage);
        } else {
            Usage compatibleUsage = parseResponseUsage(chunk);
            if (compatibleUsage.totalTokens() > 0) {
                state.usage = compatibleUsage;
            }
        }

        ONode delta = JsonSupport.child(chunk, "choices", 0, "delta");
        if (delta == null || delta.isNull()) {
            return builder.build();
        }
        String reasoning = JsonSupport.text(delta, null, "reasoning_content");
        if (reasoning == null || reasoning.isEmpty()) {
            reasoning = JsonSupport.text(delta, null, "reasoning");
        }
        if (reasoning != null && !reasoning.isEmpty()) {
            if (state.markReasoningStarted()) {
                builder.add(new StreamChunk("", Usage.ZERO)
                    .withPhase(ModelStreamPhase.REASONING_STARTED));
            }
            builder.add(new StreamChunk("", reasoning, List.of(), List.of(), Usage.ZERO, Map.of(), false));
        }
        String content = JsonSupport.text(delta, null, "content");
        if (content != null && !content.isEmpty()) {
            builder.add(new StreamChunk(content, Usage.ZERO));
        }
        ONode toolCalls = JsonSupport.child(delta, "tool_calls");
        if (toolCalls != null && toolCalls.isArray()) {
            state.accumulateToolCalls(toolCalls);
        }
        return builder.build();
    }

    /** 取请求模型 id，为空时回退到配置中的默认模型。 */
    private String model(ModelCallRequest request) {
        return request.modelId() == null || request.modelId().isBlank()
            ? config.model()
            : request.modelId();
    }

    @Override
    public Map<String, String> requestHeaders(ModelCallRequest request) {
        return ProviderInterceptor.runHeaders(
            this,
            model(request),
            request,
            Map.of("Authorization", "Bearer " + config.apiKey())
        );
    }

    /** 取请求级推理力度，未设置时回退到配置。 */
    private String reasoningEffort(ModelCallRequest request) {
        String value = option(request, "reasoningEffort");
        return value == null ? config.reasoningEffort() : value;
    }

    /** 读取请求选项中的字符串值。 */
    private String option(ModelCallRequest request, String key) {
        Object value = request.options().get(key);
        return value == null ? null : String.valueOf(value);
    }

    /** 解析 JSON 参数串；解析失败时返回空 Map。 */
    private Map<String, Object> parseArguments(String json) {
        try {
            return JsonSupport.parseObject(json);
        } catch (RuntimeException exception) {
            return Map.of();
        }
    }

    /** 序列化参数为 JSON 字符串；失败时返回空对象串。 */
    private String writeArguments(Map<String, Object> arguments) {
        try {
            return JsonSupport.write(arguments);
        } catch (RuntimeException exception) {
            return "{}";
        }
    }

    /**
     * 流式累加器：按工具调用 index 累计片段，并在流尾生成完整工具调用。
     */
    private final class Accumulator {

        /** 流中出现的错误原文。 */
        private String error;
        /** 最近一次上报的累计用量，流尾统一交付。 */
        private Usage usage = Usage.ZERO;
        /** 是否已发出本次响应的推理开始阶段。 */
        private boolean reasoningStarted;
        /** 全部原始 SSE 数据行。 */
        private final StringBuilder raw = new StringBuilder();
        private final site.sorghum.cutin.core.model.ModelHttpExchange exchange;
        /** 工具调用 index 到构建器的映射。 */
        private final Map<Integer, ToolCallBuilder> toolCalls = new LinkedHashMap<>();

        private Accumulator(site.sorghum.cutin.core.model.ModelHttpExchange exchange) {
            this.exchange = exchange;
        }

        private boolean markReasoningStarted() {
            if (reasoningStarted) return false;
            reasoningStarted = true;
            return true;
        }

        /** 按 index 累加流式工具调用增量片段。 */
        private void accumulateToolCalls(ONode deltas) {
            for (ONode delta : deltas.getArray()) {
                int index = JsonSupport.intValue(delta, 0, "index");
                ToolCallBuilder builder = toolCalls.computeIfAbsent(index, ignored -> new ToolCallBuilder());
                ONode function = JsonSupport.child(delta, "function");
                if (function == null || function.isNull()) {
                    continue;
                }
                String id = JsonSupport.text(delta, null, "id");
                if (id != null && !id.isEmpty()) {
                    builder.id = id;
                }
                String name = JsonSupport.text(function, null, "name");
                if (name != null && !name.isEmpty()) {
                    builder.name = name;
                }
                String arguments = JsonSupport.text(function, null, "arguments");
                if (arguments != null) {
                    builder.arguments.append(arguments);
                }
            }
        }

        /** 流结束时输出聚合出的工具调用与用量。 */
        private Stream<StreamChunk> finalStream() {
            if (error != null) {
                return Stream.empty();
            }
            List<ToolCall> calls = new ArrayList<>();
            for (ToolCallBuilder builder : toolCalls.values()) {
                calls.add(builder.toToolCall());
            }
            Map<String, Object> metadata = new HashMap<>();
            metadata.put("raw", raw.toString());
            metadata.put("request", exchange);
            return Stream.of(new StreamChunk(
                "",
                null,
                calls,
                List.of(),
                usage,
                metadata,
                true
            ));
        }

        /** 构造携带错误原文的终止块。 */
        private StreamChunk errorChunk() {
            Map<String, Object> metadata = new HashMap<>();
            metadata.put("error", error);
            return new StreamChunk("", null, List.of(), List.of(), usage, metadata, true);
        }

        /** 单个流式工具调用的增量构建器。 */
        private final class ToolCallBuilder {

            /** 工具调用 id。 */
            private String id = "";
            /** 工具名称。 */
            private String name = "";
            /** 参数 JSON 增量片段。 */
            private final StringBuilder arguments = new StringBuilder();

            /** 把累计片段解析为完整 ToolCall。 */
            private ToolCall toToolCall() {
                return new ToolCall(id, name, parseArguments(arguments.toString()), id);
            }
        }
    }
}
