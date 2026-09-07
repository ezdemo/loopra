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
 * OpenAI Responses 协议 Provider（/responses）。
 *
 * <p>支持同步调用、SSE 流式调用、system 指令提取、推理摘要、
 * 函数调用与用量统计；流式函数调用同样按 output_index 累加参数。</p>
 */
public final class OpenAiResponsesProvider implements ModelProvider {

    /** Provider 配置。 */
    private final ModelProviderConfig config;
    /** HTTP 传输层。 */
    private final HttpModelTransport transport;

    /** 按配置创建 Provider；请求头在发送前由拦截器生成。 */
    public OpenAiResponsesProvider(ModelProviderConfig config) {
        this.config = config;
        this.transport = new HttpModelTransport(
            config.endpoint("/responses"),
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

    /** 同步调用：解析输出条目（消息、推理、函数调用）与用量，并附带原始请求与响应体。 */
    @Override
    public ModelResponse call(ModelCallRequest request) {
        ONode body = _buildBody(request, false);
        Map<String, String> headers = requestHeaders(request);
        String raw = transport.postRaw(body, headers);
        ONode response = JsonSupport.read(raw);
        return new ModelResponse(
            parseMessage(JsonSupport.child(response, "output")),
            parseUsage(JsonSupport.child(response, "usage")),
            true,
            raw,
            transport.exchangeFor(body, headers)
        );
    }

    /** 流式调用：按 Responses SSE 事件转换为 StreamChunk，并在流尾聚合工具调用。 */
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

    /** {@inheritDoc} 构建 Responses 请求体：模型、指令、输入条目、工具与推理选项。 */
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
            ONode reasoning = JsonSupport.object();
            reasoning.set("effort", reasoningEffort);
            reasoning.set("summary", "auto");
            body.set("reasoning", reasoning);
            ONode include = JsonSupport.array();
            include.add("reasoning.encrypted_content");
            body.set("include", include);
        }else {
            ONode reasoning = JsonSupport.object();
            reasoning.set("effort", "none");
            reasoning.set("summary", "auto");
            body.set("reasoning", reasoning);
        }
        StringBuilder instructions = new StringBuilder();
        ONode input = JsonSupport.array();
        body.set("input", input);
        for (Message message : request.messages()) {
            if ("system".equals(message.role())) {
                if (message.content() != null && !message.content().isEmpty()) {
                    if (instructions.length() > 0) {
                        instructions.append("\n\n");
                    }
                    instructions.append(message.content());
                }
                continue;
            }
            toResponsesInput(message, input);
        }
        if (instructions.length() > 0) {
            body.set("instructions", instructions.toString());
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

    /** 把通用 Message 转换为 Responses input 条目，特殊处理 tool 结果与历史推理。 */
    private void toResponsesInput(Message message, ONode input) {
        if ("tool".equals(message.role())) {
            ONode item = JsonSupport.object();
            item.set("type", "function_call_output");
            item.set("call_id", message.toolCallId() == null ? "" : message.toolCallId());
            item.set("output", message.content() == null || message.content().isEmpty()
                ? "ERROR tool execution failed or returned empty"
                : message.content());
            input.add(item);
            return;
        }

        Object responseReasoning = message.metadata("response_reasoning");
        if (responseReasoning != null) {
            try {
                ONode reasoningItem = JsonSupport.read(String.valueOf(responseReasoning));
                if (reasoningItem.isObject()) {
                    reasoningItem.remove("status");
                    input.add(reasoningItem);
                }
            } catch (RuntimeException ignored) {
                // 无效的历史推理条目直接丢弃
            }
        }

        if (message.metadata("images") instanceof List<?> images && !images.isEmpty()) {
            ONode item = JsonSupport.object();
            item.set("role", message.role());
            ONode content = JsonSupport.array();
            if (message.content() != null && !message.content().isEmpty()) {
                ONode text = JsonSupport.object();
                text.set("type", "input_text");
                text.set("text", message.content());
                content.add(text);
            }
            for (Object image : images) {
                ONode imagePart = JsonSupport.object();
                imagePart.set("type", "input_image");
                imagePart.set("image_url", String.valueOf(image));
                content.add(imagePart);
            }
            item.set("content", content);
            input.add(item);
        } else if (message.content() != null && !message.content().isEmpty()) {
            ONode item = JsonSupport.object();
            item.set("role", message.role());
            item.set("content", message.content());
            input.add(item);
        }
        if (message.hasToolCalls()) {
            for (ToolCall toolCall : message.toolCalls()) {
                ONode item = JsonSupport.object();
                item.set("type", "function_call");
                item.set("id", toolCall.id());
                item.set("call_id", toolCall.id());
                item.set("name", toolCall.toolId());
                item.set("arguments", writeArguments(toolCall.arguments()));
                input.add(item);
            }
        }
    }

    /** 把工具定义转换为 Responses 工具声明。 */
    private void addTools(ONode body, List<ToolDefinition> tools) {
        if (tools == null || tools.isEmpty()) {
            return;
        }
        ONode node = JsonSupport.array();
        body.set("tools", node);
        for (ToolDefinition tool : tools) {
            ONode entry = JsonSupport.object();
            entry.set("type", "function");
            entry.set("name", tool.id());
            entry.set("description", tool.description());
            entry.set("parameters", JsonSupport.bean(tool.inputSchema()));
            node.add(entry);
        }
    }

    /** 解析 output 数组为最终 assistant 消息，合并正文、推理与函数调用。 */
    private Message parseMessage(ONode output) {
        StringBuilder content = new StringBuilder();
        StringBuilder reasoning = new StringBuilder();
        List<ToolCall> calls = new ArrayList<>();
        ONode reasoningItem = null;
        ONode outputItems = output == null || !output.isArray() ? JsonSupport.array() : output;
        for (ONode item : outputItems.getArray()) {
            String type = JsonSupport.text(item, "", "type");
            if ("reasoning".equals(type)) {
                reasoningItem = item;
                ONode summary = JsonSupport.child(item, "summary");
                if (summary != null && summary.isArray()) {
                    for (ONode part : summary.getArray()) {
                        reasoning.append(JsonSupport.text(part, "", "text"));
                    }
                }
            } else if ("message".equals(type)) {
                ONode contentParts = JsonSupport.child(item, "content");
                if (contentParts != null && contentParts.isArray()) {
                    for (ONode part : contentParts.getArray()) {
                        String partType = JsonSupport.text(part, "", "type");
                        if ("output_text".equals(partType) || "refusal".equals(partType)) {
                            content.append(JsonSupport.text(part, "", "text"));
                        }
                    }
                }
            } else if ("function_call".equals(type)) {
                String callId = JsonSupport.text(item, "", "call_id");
                if (callId.isEmpty()) {
                    callId = JsonSupport.text(item, "", "id");
                }
                String name = JsonSupport.text(item, "", "name");
                String arguments = JsonSupport.text(item, "{}", "arguments");
                calls.add(new ToolCall(callId, name, parseArguments(arguments), callId));
            }
        }
        Map<String, Object> metadata = new HashMap<>();
        if (reasoning.length() > 0) {
            metadata.put("reasoning_content", reasoning.toString());
        }
        if (reasoningItem != null) {
            metadata.put("response_reasoning", reasoningItem.toJson());
        }
        return new Message("assistant", content.toString(), null, calls, metadata);
    }

    /** 解析 Responses 用量节点；缺失时返回零用量。 */
    private Usage parseUsage(ONode usage) {
        if (usage == null || usage.isNull()) {
            return Usage.ZERO;
        }
        long cacheRead = JsonSupport.longValue(usage, 0, "input_tokens_details", "cached_tokens");
        if (cacheRead == 0) {
            // 兼容旧版 Responses 用量中的顶层字段
            cacheRead = JsonSupport.longValue(usage, 0, "cached_input_tokens");
        }
        return new Usage(
            JsonSupport.longValue(usage, 0, "input_tokens"),
            JsonSupport.longValue(usage, 0, "output_tokens"),
            JsonSupport.longValue(usage, 0, "cost_micros"),
            cacheRead,
            0
        );
    }

    /** 把单个 SSE 事件转换为 StreamChunk，并按事件类型累加状态。 */
    private Stream<StreamChunk> parseChunk(ONode chunk, Accumulator state) {
        Stream.Builder<StreamChunk> builder = Stream.builder();
        String type = JsonSupport.text(chunk, "", "type");
        switch (type) {
            case "response.output_text.delta", "response.refusal.delta" -> {
                String delta = JsonSupport.text(chunk, "", "delta");
                if (!delta.isEmpty()) {
                    builder.add(new StreamChunk(delta, Usage.ZERO));
                }
            }
            case "response.reasoning_summary_text.delta", "response.reasoning_text.delta" -> {
                String delta = JsonSupport.text(chunk, "", "delta");
                if (!delta.isEmpty()) {
                    state.reasoningTextDelivered = true;
                    builder.add(new StreamChunk("", delta, List.of(), List.of(), Usage.ZERO, Map.of(), false));
                }
            }
            case "response.output_item.added", "response.output_item.done" -> {
                ONode item = JsonSupport.child(chunk, "item");
                if (item != null && item.isObject()) {
                    if ("reasoning".equals(JsonSupport.text(item, "", "type"))) {
                        state.captureReasoning(item);
                        boolean itemStarted = "response.output_item.added".equals(type);
                        boolean encryptedContentAvailable =
                            !JsonSupport.text(item, "", "encrypted_content").isEmpty();
                        if ((itemStarted || encryptedContentAvailable)
                            && state.markReasoningStarted()) {
                            builder.add(new StreamChunk("", Usage.ZERO)
                                .withPhase(ModelStreamPhase.REASONING_STARTED));
                        }
                    }
                    state.setOutputItem(
                        JsonSupport.intValue(chunk, 0, "output_index"),
                        item,
                        "response.output_item.done".equals(type)
                    );
                }
            }
            case "response.function_call_arguments.delta" -> state.appendArguments(
                JsonSupport.intValue(chunk, 0, "output_index"),
                JsonSupport.text(chunk, "", "delta")
            );
            case "response.function_call_arguments.done" -> state.replaceArguments(
                JsonSupport.intValue(chunk, 0, "output_index"),
                JsonSupport.text(chunk, "", "arguments")
            );
            case "response.completed" -> {
                state.completed = true;
                ONode usage = JsonSupport.child(chunk, "response", "usage");
                if (usage != null && !usage.isNull()) {
                    Usage delta = parseUsage(usage);
                    state.usage = state.usage.add(delta);
                    state.usageDelivered = true;
                    builder.add(new StreamChunk("", delta));
                }
            }
            case "response.failed", "response.incomplete", "error" -> {
                state.error = chunk.toJson();
                builder.add(state.errorChunk());
            }
            default -> {
                // 生命周期事件不产生用户可见增量
            }
        }
        return builder.build();
    }

    /** 取请求模型 id，为空时回退到配置中的默认模型。 */
    private String model(ModelCallRequest request) {
        return request.modelId() == null || request.modelId().isBlank()
            ? config.model()
            : request.modelId();
    }
    /** 生成本次请求的最终请求头，保证会话级插件看到最新请求选项。 */
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
     * 流式累加器：按 output_index 记录函数调用，并在流尾生成完整调用。
     */
    private final class Accumulator {

        /** 流中出现的错误原文。 */
        private String error;
        /** 已累计的用量。 */
        private Usage usage = Usage.ZERO;
        /** 响应是否已完成。 */
        private boolean completed;
        /** 用量是否已通过增量块交付过。 */
        private boolean usageDelivered;
        /** 是否已发出本次响应的推理开始阶段。 */
        private boolean reasoningStarted;
        /** 是否已流式交付过推理文本增量（决定 terminal 块是否还需携带全文兜底）。 */
        private boolean reasoningTextDelivered;
        /** 全部原始 SSE 数据行。 */
        private final StringBuilder raw = new StringBuilder();
        private final site.sorghum.cutin.core.model.ModelHttpExchange exchange;
        private final Map<Integer, ONode> reasoningItems = new LinkedHashMap<>();
        private ONode latestReasoning;
        /** 函数调用 output_index 到构建器的映射。 */
        private final Map<Integer, ToolCallBuilder> toolCalls = new LinkedHashMap<>();

        private Accumulator(site.sorghum.cutin.core.model.ModelHttpExchange exchange) {
            this.exchange = exchange;
        }

        private boolean markReasoningStarted() {
            if (reasoningStarted) {
                return false;
            }
            reasoningStarted = true;
            return true;
        }

        private void captureReasoning(ONode item) {
            try {
                ONode copy = JsonSupport.read(item.toJson());
                copy.remove("status");
                int index = -1;
                String id = JsonSupport.text(copy, "", "id");
                if (id.isEmpty()) {
                    for (Map.Entry<Integer, ONode> entry : reasoningItems.entrySet()) {
                        if (JsonSupport.text(entry.getValue(), "", "id").equals(JsonSupport.text(item, "", "id"))) {
                            index = entry.getKey();
                            break;
                        }
                    }
                }
                if (index >= 0) {
                    reasoningItems.put(index, copy);
                } else if (!reasoningItems.isEmpty()) {
                    int max = reasoningItems.keySet().stream().mapToInt(Integer::intValue).max().orElse(-1);
                    reasoningItems.put(max, copy);
                    latestReasoning = copy;
                } else {
                    reasoningItems.put(0, copy);
                    latestReasoning = copy;
                }
                latestReasoning = copy;
            } catch (RuntimeException ignored) {
            }
        }

        /** 从输出条目事件中登记或更新函数调用。 */
        private void setOutputItem(int index, ONode item, boolean replaceArguments) {
            if ("function_call".equals(JsonSupport.text(item, "", "type"))) {
                ToolCallBuilder builder = toolCalls.computeIfAbsent(index, ignored -> new ToolCallBuilder());
                String callId = JsonSupport.text(item, "", "call_id");
                if (callId.isEmpty()) {
                    callId = JsonSupport.text(item, "", "id");
                }
                if (!callId.isEmpty()) {
                    builder.id = callId;
                }
                String name = JsonSupport.text(item, "", "name");
                if (!name.isEmpty()) {
                    builder.name = name;
                }
                String arguments = JsonSupport.text(item, null, "arguments");
                if (arguments != null) {
                    if (replaceArguments) {
                        builder.arguments = new StringBuilder(arguments);
                    } else {
                        builder.arguments.append(arguments);
                    }
                }
            }
        }

        /** 追加一段参数增量。 */
        private void appendArguments(int index, String arguments) {
            if (arguments == null) {
                return;
            }
            toolCalls.computeIfAbsent(index, ignored -> new ToolCallBuilder()).arguments.append(arguments);
        }

        /** 用完整参数覆盖增量参数。 */
        private void replaceArguments(int index, String arguments) {
            if (arguments == null) {
                return;
            }
            toolCalls.computeIfAbsent(index, ignored -> new ToolCallBuilder())
                .arguments = new StringBuilder(arguments);
        }

        /** 流结束时输出聚合出的函数调用与未交付的用量。 */
        private Stream<StreamChunk> finalStream() {
            if (error != null) {
                return Stream.empty();
            }
            List<ToolCall> calls = new ArrayList<>();
            for (ToolCallBuilder builder : toolCalls.values()) {
                calls.add(builder.toToolCall());
            }
            List<String> thinkingBlocks = List.of();
            String reasoningContent = null;
            ONode item = latestReasoning != null ? latestReasoning : reasoningItems.values().stream().findFirst().orElse(null);
            if (item != null) {
                ONode summary = JsonSupport.child(item, "summary");
                if (summary != null && summary.isArray()) {
                    StringBuilder sb = new StringBuilder();
                    for (ONode part : summary.getArray()) {
                        sb.append(JsonSupport.text(part, "", "text"));
                    }
                    if (sb.length() > 0) {
                        reasoningContent = sb.toString();
                    }
                }
            }
            Map<String, Object> metadata = new HashMap<>();
            metadata.put("raw", raw.toString());
            metadata.put("request", exchange);
            if (latestReasoning != null) {
                metadata.put("response_reasoning", latestReasoning.toJson());
            }
            if (reasoningContent != null) {
                metadata.put("reasoning_content", reasoningContent);
            }
            // 推理文本已随增量流交付过时，terminal 不再重复携带全文（避免前端把同一段思考追加两遍）；
            // 仅当流中从未出现推理增量（如模型一次性返回 summary）时才兜底携带，保证实时渲染不丢失。
            String terminalReasoning = reasoningTextDelivered ? null : reasoningContent;
            return Stream.of(new StreamChunk(
                "",
                terminalReasoning,
                calls,
                thinkingBlocks,
                usageDelivered ? Usage.ZERO : usage,
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

        /** 单个函数调用的增量构建器。 */
        private final class ToolCallBuilder {

            /** 调用 id。 */
            private String id = "";
            /** 函数名称。 */
            private String name = "";
            /** 参数 JSON 增量片段。 */
            private StringBuilder arguments = new StringBuilder();

            /** 把累计片段解析为完整 ToolCall。 */
            private ToolCall toToolCall() {
                return new ToolCall(id, name, parseArguments(arguments.toString()), id);
            }
        }
    }
}
