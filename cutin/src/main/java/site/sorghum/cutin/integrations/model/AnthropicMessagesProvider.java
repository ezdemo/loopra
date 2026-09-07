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
 * Anthropic Messages 协议 Provider（/v1/messages）。
 *
 * <p>支持同步调用、SSE 流式调用、system 提取、thinking 块、
 * tool_use 与 tool_result、用量统计；消息转换时会合并连续的 user 内容块，
 * 以满足 Anthropic 相邻 user 消息需要合并的协议要求。</p>
 */
public final class AnthropicMessagesProvider implements ModelProvider {

    /** Anthropic API 版本头。 */
    private static final String ANTHROPIC_VERSION = "2023-06-01";
    /** Provider 配置。 */
    private final ModelProviderConfig config;
    /** HTTP 传输层。 */
    private final HttpModelTransport transport;

    /** 按配置创建 Provider；请求头在发送前由拦截器生成。 */
    public AnthropicMessagesProvider(ModelProviderConfig config) {
        this.config = config;
        this.transport = new HttpModelTransport(
            config.endpoint("/v1/messages"),
            Map.of(
                "x-api-key", config.apiKey(),
                "api-key", config.apiKey(),
                "anthropic-version", ANTHROPIC_VERSION
            )
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

    /** 同步调用：解析内容块（text、thinking、tool_use）与用量，并附带原始请求与响应体。 */
    @Override
    public ModelResponse call(ModelCallRequest request) {
        ONode body = _buildBody(request, false);
        Map<String, String> headers = requestHeaders(request);
        String raw = transport.postRaw(body, headers);
        ONode response = JsonSupport.read(raw);
        return new ModelResponse(
            parseMessage(JsonSupport.child(response, "content")),
            parseUsage(JsonSupport.child(response, "usage")),
            true,
            raw,
            transport.exchangeFor(body, headers)
        );
    }

    /** 流式调用：按 Anthropic SSE 事件转换为 StreamChunk，并在流尾聚合工具与 thinking。 */
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

    /** {@inheritDoc} 构建 Messages 基础请求体：模型、system、消息、工具与流标记。 */
    @Override
    public ONode buildBody(ModelCallRequest request, boolean stream) {
        ONode body = JsonSupport.object();
        String model = model(request);
        body.set("model", model);
        body.set("stream", stream);

        StringBuilder system = new StringBuilder();
        List<ONode> messages = new ArrayList<>();
        for (Message message : request.messages()) {
            if ("system".equals(message.role())) {
                if (message.content() != null && !message.content().isEmpty()) {
                    if (system.length() > 0) {
                        system.append("\n\n");
                    }
                    system.append(message.content());
                }
                continue;
            }
            ONode converted = toAnthropicMessage(message);
            if (converted != null) {
                messages.add(converted);
            }
        }
        if (system.length() > 0) {
            body.set("system", system.toString());
        }

        ONode bodyMessages = JsonSupport.array();
        body.set("messages", bodyMessages);
        ONode pendingUser = null;
        for (ONode message : messages) {
            if ("user".equals(JsonSupport.text(message, "", "role"))) {
                if (pendingUser == null) {
                    pendingUser = message;
                } else {
                    ONode merged = JsonSupport.array();
                    merged.addAll(pendingUser.getOrNew("content").getArray());
                    merged.addAll(message.getOrNew("content").getArray());
                    pendingUser.set("content", merged);
                }
                continue;
            }
            if (pendingUser != null) {
                finalizeContent(pendingUser);
                bodyMessages.add(pendingUser);
                pendingUser = null;
            }
            finalizeContent(message);
            bodyMessages.add(message);
        }
        if (pendingUser != null) {
            finalizeContent(pendingUser);
            bodyMessages.add(pendingUser);
        }

        addTools(body, request.tools());
        String userId = option(request, "userId");
        if (userId != null && !userId.isBlank()) {
            ONode metadata = JsonSupport.object();
            metadata.set("user_id", userId);
            body.set("metadata", metadata);
        }
        return body;
    }

    /** 把通用 Message 转换为 Anthropic 消息内容块，特殊处理 tool_result 与 thinking。 */
    private ONode toAnthropicMessage(Message message) {
        if ("tool".equals(message.role())) {
            ONode node = JsonSupport.object();
            node.set("role", "user");
            ONode content = JsonSupport.array();
            node.set("content", content);
            ONode block = JsonSupport.object();
            block.set("type", "tool_result");
            block.set("tool_use_id", message.toolCallId() == null ? "" : message.toolCallId());
            block.set("content", message.content() == null || message.content().isEmpty()
                ? "ERROR tool execution failed or returned empty"
                : message.content());
            content.add(block);
            return node;
        }
        if ("user".equals(message.role())) {
            ONode node = JsonSupport.object();
            node.set("role", "user");
            ONode content = JsonSupport.array();
            node.set("content", content);
            if (message.content() != null && !message.content().isEmpty()) {
                ONode block = JsonSupport.object();
                block.set("type", "text");
                block.set("text", message.content());
                content.add(block);
            }
            if (message.metadata("images") instanceof List<?> images) {
                for (Object image : images) {
                    appendImageBlock(content, image);
                }
            }
            if (content.isEmpty()) {
                return null;
            }
            return node;
        }
        if ("assistant".equals(message.role())) {
            ONode node = JsonSupport.object();
            node.set("role", "assistant");
            ONode content = JsonSupport.array();
            node.set("content", content);
            Object thinkingBlocks = message.metadata("thinking_blocks");
            if (thinkingBlocks instanceof List<?> blocks) {
                for (Object blockValue : blocks) {
                    try {
                        ONode block = JsonSupport.read(String.valueOf(blockValue));
                        String type = JsonSupport.text(block, "", "type");
                        if ("thinking".equals(type) || "redacted_thinking".equals(type)) {
                            content.add(block);
                        }
                    } catch (RuntimeException ignored) {
                        // 损坏的历史思考块直接跳过
                    }
                }
            }
            if (message.content() != null && !message.content().isEmpty()) {
                ONode block = JsonSupport.object();
                block.set("type", "text");
                block.set("text", message.content());
                content.add(block);
            }
            for (ToolCall toolCall : message.toolCalls()) {
                ONode block = JsonSupport.object();
                block.set("type", "tool_use");
                block.set("id", toolCall.id());
                block.set("name", toolCall.toolId());
                block.set("input", JsonSupport.bean(toolCall.arguments()));
                content.add(block);
            }
            if (content.isEmpty()) {
                return null;
            }
            return node;
        }
        return null;
    }

    private static void appendImageBlock(ONode content, Object image) {
        if (image == null) {
            return;
        }
        String value = String.valueOf(image).trim();
        if (value.isEmpty()) {
            return;
        }
        ONode block = JsonSupport.object();
        block.set("type", "image");
        ONode source = JsonSupport.object();
        block.set("source", source);
        if (value.startsWith("data:") && value.contains(";base64,")) {
            int separator = value.indexOf(",");
            String mediaType = value.substring("data:".length(), value.indexOf(";base64,"));
            if (mediaType.isBlank()) {
                mediaType = "image/png";
            }
            source.set("type", "base64");
            source.set("media_type", mediaType);
            source.set("data", value.substring(separator + 1));
        } else {
            source.set("type", "url");
            source.set("url", value);
        }
        content.add(block);
    }

    /** 把工具定义转换为 Anthropic tool 声明。 */
    private void addTools(ONode body, List<ToolDefinition> tools) {
        if (tools == null || tools.isEmpty()) {
            return;
        }
        ONode node = JsonSupport.array();
        body.set("tools", node);
        for (ToolDefinition tool : tools) {
            ONode entry = JsonSupport.object();
            entry.set("name", tool.id());
            entry.set("description", tool.description());
            entry.set("input_schema", JsonSupport.bean(tool.inputSchema()));
            node.add(entry);
        }
    }

    /** 解析响应内容块为最终 assistant 消息，合并 text、thinking 与 tool_use。 */
    private Message parseMessage(ONode content) {
        StringBuilder text = new StringBuilder();
        StringBuilder reasoning = new StringBuilder();
        List<ToolCall> calls = new ArrayList<>();
        List<String> thinkingBlocks = new ArrayList<>();
        ONode contentBlocks = content == null || !content.isArray() ? JsonSupport.array() : content;
        for (ONode block : contentBlocks.getArray()) {
            String type = JsonSupport.text(block, "", "type");
            if ("text".equals(type)) {
                text.append(JsonSupport.text(block, "", "text"));
            } else if ("thinking".equals(type)) {
                reasoning.append(JsonSupport.text(block, "", "thinking"));
                thinkingBlocks.add(block.toJson());
            } else if ("redacted_thinking".equals(type)) {
                thinkingBlocks.add(block.toJson());
            } else if ("tool_use".equals(type)) {
                String callId = JsonSupport.text(block, "", "id");
                String name = JsonSupport.text(block, "", "name");
                Map<String, Object> input = JsonSupport.toMap(JsonSupport.child(block, "input"));
                calls.add(new ToolCall(callId, name, input, callId));
            }
        }
        Map<String, Object> metadata = new HashMap<>();
        if (reasoning.length() > 0) {
            metadata.put("reasoning_content", reasoning.toString());
        }
        if (!thinkingBlocks.isEmpty()) {
            metadata.put("thinking_blocks", List.copyOf(thinkingBlocks));
        }
        return new Message("assistant", text.toString(), null, calls, metadata);
    }

    /** 解析用量节点；缺失时返回零用量。 */
    private Usage parseUsage(ONode usage) {
        if (usage == null || usage.isNull()) {
            return Usage.ZERO;
        }
        long inputTokens = JsonSupport.longValue(usage, 0, "input_tokens");
        long cacheRead = JsonSupport.longValue(usage, 0, "cache_read_input_tokens");
        long cacheCreation = JsonSupport.longValue(usage, 0, "cache_creation_input_tokens");
        return new Usage(
            // Anthropic 的 input_tokens 不含缓存读写，这里合并为全部输入
            inputTokens + cacheRead + cacheCreation,
            JsonSupport.longValue(usage, 0, "output_tokens"),
            JsonSupport.longValue(usage, 0, "cost_micros"),
            cacheRead,
            cacheCreation
        );
    }

    /** 把单个 SSE 事件转换为 StreamChunk，并按事件类型累加 thinking、工具与用量。 */
    private Stream<StreamChunk> parseChunk(ONode chunk, Accumulator state) {
        Stream.Builder<StreamChunk> builder = Stream.builder();
        String type = JsonSupport.text(chunk, "", "type");
        switch (type) {
            case "message_start" -> {
                ONode usage = JsonSupport.child(chunk, "message", "usage");
                if (usage != null && !usage.isNull()) {
                    state.inputUsage = usage;
                }
            }
            case "content_block_start" -> {
                if (state.contentBlockStart(
                    JsonSupport.child(chunk, "content_block"),
                    JsonSupport.intValue(chunk, 0, "index")
                )) {
                    builder.add(new StreamChunk("", Usage.ZERO)
                        .withPhase(ModelStreamPhase.REASONING_STARTED));
                }
            }
            case "content_block_delta" -> {
                ONode delta = JsonSupport.child(chunk, "delta");
                String deltaType = JsonSupport.text(delta, "", "type");
                switch (deltaType) {
                    case "text_delta" -> {
                        String text = JsonSupport.text(delta, "", "text");
                        if (!text.isEmpty()) {
                            builder.add(new StreamChunk(text, Usage.ZERO));
                        }
                    }
                    case "thinking_delta" -> {
                        String thinking = JsonSupport.text(delta, "", "thinking");
                        if (!thinking.isEmpty()) {
                            if (state.markReasoningStarted()) {
                                builder.add(new StreamChunk("", Usage.ZERO)
                                    .withPhase(ModelStreamPhase.REASONING_STARTED));
                            }
                            state.appendThinking(thinking);
                            builder.add(new StreamChunk(
                                "",
                                thinking,
                                List.of(),
                                List.of(),
                                Usage.ZERO,
                                Map.of(),
                                false
                            ));
                        }
                    }
                    case "signature_delta" -> state.appendSignature(JsonSupport.text(delta, "", "signature"));
                    case "redacted_thinking_delta" -> {
                        if (state.markReasoningStarted()) {
                            builder.add(new StreamChunk("", Usage.ZERO)
                                .withPhase(ModelStreamPhase.REASONING_STARTED));
                        }
                        state.appendRedacted(JsonSupport.text(delta, "", "data"));
                    }
                    case "input_json_delta" -> state.appendArguments(
                        JsonSupport.intValue(chunk, 0, "index"),
                        JsonSupport.text(delta, "", "partial_json")
                    );
                    default -> {
                        // 无用户可见增量
                    }
                }
            }
            case "content_block_stop" -> state.finishThinkingBlock();
            case "message_delta" -> {
                ONode usage = JsonSupport.child(chunk, "usage");
                if (usage != null && !usage.isNull()) {
                    Usage delta = state.combinedUsage(usage);
                    state.usageDelivered = true;
                    builder.add(new StreamChunk("", delta));
                }
            }
            case "message_stop" -> state.completed = true;
            case "error" -> {
                state.error = chunk.toJson();
                builder.add(state.errorChunk());
            }
            default -> {
                // ping 等生命周期事件忽略
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
            Map.of(
                "x-api-key", config.apiKey(),
                "api-key", config.apiKey(),
                "anthropic-version", ANTHROPIC_VERSION
            )
        );
    }

    /** 读取请求选项中的字符串值。 */
    private String option(ModelCallRequest request, String key) {
        Object value = request.options().get(key);
        return value == null ? null : String.valueOf(value);
    }

    /** 若内容数组只有一个 text 块，则简化为纯文本字符串，符合 Anthropic 格式。 */
    private static void finalizeContent(ONode message) {
        ONode content = JsonSupport.child(message, "content");
        if (content != null && content.isArray() && content.size() == 1
            && "text".equals(JsonSupport.text(content.get(0), "", "type"))) {
            message.set("content", JsonSupport.text(content.get(0), "", "text"));
        }
    }

    /**
     * 流式累加器：按内容块 index 记录 thinking 与 tool_use，并在流尾生成完整结果。
     */
    private final class Accumulator {

        /** 流中出现的错误原文。 */
        private String error;
        /** 已累计的用量。 */
        private Usage usage = Usage.ZERO;
        /** 消息是否已完成。 */
        private boolean completed;
        /** 用量是否已通过增量块交付过。 */
        private boolean usageDelivered;
        /** message_start 中的输入用量。 */
        private ONode inputUsage;
        /** 全部原始 SSE 数据行。 */
        private final StringBuilder raw = new StringBuilder();
        private final site.sorghum.cutin.core.model.ModelHttpExchange exchange;
        /** 正在累积的 thinking 块。 */
        private ONode activeThinkingBlock;
        /** 是否已发出本次响应的推理开始阶段。 */
        private boolean reasoningStarted;

        private Accumulator(site.sorghum.cutin.core.model.ModelHttpExchange exchange) {
            this.exchange = exchange;
        }
        /** 已完成的 thinking 块列表。 */
        private final List<String> thinkingBlocks = new ArrayList<>();
        /** 内容块 index 到工具调用构建器的映射。 */
        private final Map<Integer, ToolCallBuilder> toolCalls = new LinkedHashMap<>();

        /** 内容块开始时登记 thinking 或 tool_use 的元信息。 */
        private boolean contentBlockStart(ONode block, int index) {
            if (block == null || block.isNull()) {
                return false;
            }
            String type = JsonSupport.text(block, "", "type");
            if ("thinking".equals(type) || "redacted_thinking".equals(type)) {
                ONode active = JsonSupport.object();
                active.set("type", type);
                String thinking = JsonSupport.text(block, null, "thinking");
                if (thinking != null) {
                    active.set("thinking", thinking);
                }
                String signature = JsonSupport.text(block, null, "signature");
                if (signature != null) {
                    active.set("signature", signature);
                }
                String data = JsonSupport.text(block, null, "data");
                if (data != null) {
                    active.set("data", data);
                }
                activeThinkingBlock = active;
                return markReasoningStarted();
            }
            if (!"tool_use".equals(type)) {
                return false;
            }
            ToolCallBuilder builder = toolCalls.computeIfAbsent(index, ignored -> new ToolCallBuilder());
            String id = JsonSupport.text(block, "", "id");
            if (!id.isEmpty()) {
                builder.id = id;
            }
            String name = JsonSupport.text(block, "", "name");
            if (!name.isEmpty()) {
                builder.name = name;
            }
            return false;
        }

        private boolean markReasoningStarted() {
            if (reasoningStarted) return false;
            reasoningStarted = true;
            return true;
        }

        /** 追加 thinking 增量文本。 */
        private void appendThinking(String delta) {
            if (activeThinkingBlock == null) {
                return;
            }
            String previous = JsonSupport.text(activeThinkingBlock, "", "thinking");
            activeThinkingBlock.set("thinking", previous + delta);
        }

        /** 追加 thinking 签名。 */
        private void appendSignature(String signature) {
            if (activeThinkingBlock != null && !signature.isEmpty()) {
                activeThinkingBlock.set("signature", signature);
            }
        }

        /** 追加 redacted thinking 数据。 */
        private void appendRedacted(String data) {
            if (activeThinkingBlock != null && !data.isEmpty()) {
                activeThinkingBlock.set("data", data);
            }
        }

        /** 内容块结束时归档当前 thinking 块。 */
        private void finishThinkingBlock() {
            if (activeThinkingBlock == null) {
                return;
            }
            thinkingBlocks.add(activeThinkingBlock.toJson());
            activeThinkingBlock = null;
        }

        /** 追加工具参数 JSON 增量。 */
        private void appendArguments(int index, String arguments) {
            if (arguments == null) {
                return;
            }
            ToolCallBuilder builder = toolCalls.computeIfAbsent(index, ignored -> new ToolCallBuilder());
            builder.arguments.append(arguments);
        }

        /** 合并 message_start 的输入用量与 message_delta 的输出用量，返回本块增量。 */
        private Usage combinedUsage(ONode outputUsage) {
            ONode combined = JsonSupport.object();
            long inputTokens = inputUsage == null ? 0 : JsonSupport.longValue(inputUsage, 0, "input_tokens");
            long outputTokens = JsonSupport.longValue(outputUsage, 0, "output_tokens");
            long cacheRead = inputUsage == null ? 0 : JsonSupport.longValue(inputUsage, 0, "cache_read_input_tokens");
            long cacheCreation = inputUsage == null ? 0
                : JsonSupport.longValue(inputUsage, 0, "cache_creation_input_tokens");
            combined.set("input_tokens", inputTokens);
            combined.set("output_tokens", outputTokens);
            combined.set("cache_read_input_tokens", cacheRead);
            combined.set("cache_creation_input_tokens", cacheCreation);
            combined.set("total_tokens", inputTokens + outputTokens);
            Usage delta = parseUsage(combined);
            usage = usage.add(delta);
            return delta;
        }

        /** 流结束时输出聚合出的工具调用、thinking 块与未交付的用量。 */
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
                List.copyOf(thinkingBlocks),
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

        /** 单个 tool_use 调用的增量构建器。 */
        private final class ToolCallBuilder {

            /** 工具调用 id。 */
            private String id = "";
            /** 工具名称。 */
            private String name = "";
            /** 参数 JSON 增量片段。 */
            private final StringBuilder arguments = new StringBuilder();

            /** 把累计片段解析为完整 ToolCall。 */
            private ToolCall toToolCall() {
                Map<String, Object> input;
                try {
                    input = JsonSupport.parseObject(arguments.toString());
                } catch (RuntimeException exception) {
                    input = Map.of();
                }
                return new ToolCall(id, name, input, id);
            }
        }
    }
}
