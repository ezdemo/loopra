package site.sorghum.cutin.core.model;

import site.sorghum.cutin.core.context.LoopContext;
import site.sorghum.cutin.core.context.Message;
import site.sorghum.cutin.core.context.Usage;
import site.sorghum.cutin.core.event.EventBus;
import site.sorghum.cutin.core.event.LoopEvent;
import site.sorghum.cutin.core.loop.InterceptContext;
import site.sorghum.cutin.core.loop.InterceptDecision;
import site.sorghum.cutin.core.loop.InterceptPoint;
import site.sorghum.cutin.core.loop.InterceptionResult;
import site.sorghum.cutin.core.loop.InterceptorRegistry;
import site.sorghum.cutin.core.loop.LoopAbortException;
import site.sorghum.cutin.core.loop.LoopGotoException;
import site.sorghum.cutin.core.loop.LoopRetryException;
import site.sorghum.cutin.core.loop.LoopSuspendException;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.NoSuchElementException;
import java.util.Spliterator;
import java.util.Spliterators;
import java.util.stream.Stream;
import java.util.stream.StreamSupport;

/**
 * 带完整模型拦截链的网关。
 *
 * <p>同步调用执行 {@code BEFORE_MODEL} → Provider → {@code AFTER_MODEL}，
 * 失败时执行 {@code ON_MODEL_ERROR}；流式调用额外在每个增量块上执行
 * {@code ON_MODEL_STREAM}。拦截器可以替换请求、增量块或最终响应，
 * 也可以触发重试、跳转、挂起或中止。</p>
 */
public final class InterceptingModelGateway implements ModelGateway {

    /** 真正执行 Provider 路由的下层网关。 */
    private final ModelGateway delegate;
    /** 拦截器注册表。 */
    private final InterceptorRegistry interceptors;
    /** 事件总线，用于发布模型流事件。 */
    private final EventBus events;

    /** 包装基础网关并接入拦截链与事件总线。 */
    public InterceptingModelGateway(
        ModelGateway delegate,
        InterceptorRegistry interceptors,
        EventBus events
    ) {
        this.delegate = delegate;
        this.interceptors = interceptors;
        this.events = events;
    }

    /**
     * 同步模型调用。
     *
     * <p>BEFORE_MODEL 可替换 {@link ModelCallRequest} 或上下文；
     * AFTER_MODEL 可替换 {@link ModelResponse}；Provider 抛错时先走
     * {@code ON_MODEL_ERROR} 再向上抛出。</p>
     */
    @Override
    public ModelResponse call(ModelCallRequest request, LoopContext context) {
        InterceptionResult before = interceptors.run(
            InterceptPoint.BEFORE_MODEL,
            new InterceptContext(InterceptPoint.BEFORE_MODEL, null, null, context, request)
        );
        throwIfTerminal(before.decision());

        ModelCallRequest effectiveRequest = effectiveRequest(request, before);
        ModelResponse response;
        try {
            response = delegate.call(effectiveRequest, before.context());
        } catch (RuntimeException exception) {
            InterceptionResult error = interceptors.run(
                InterceptPoint.ON_MODEL_ERROR,
                new InterceptContext(
                    InterceptPoint.ON_MODEL_ERROR,
                    null,
                    null,
                    before.context(),
                    new ModelCallError(exception.getMessage(), exception)
                )
            );
            throwIfTerminal(error.decision());
            throw exception;
        }

        InterceptionResult after = interceptors.run(
            InterceptPoint.AFTER_MODEL,
            new InterceptContext(InterceptPoint.AFTER_MODEL, null, null, before.context(), response)
        );
        throwIfTerminal(after.decision());
        return after.payload() != response && after.payload() instanceof ModelResponse replacement
            ? replacement
            : response;
    }

    /** 流式模型调用，按增量块执行拦截链并负责合成终止块。 */
    @Override
    public Stream<StreamChunk> stream(ModelCallRequest request, LoopContext context) {
        InterceptionResult before = interceptors.run(
            InterceptPoint.BEFORE_MODEL,
            new InterceptContext(InterceptPoint.BEFORE_MODEL, null, null, context, request)
        );
        throwIfTerminal(before.decision());
        ModelCallRequest effectiveRequest = effectiveRequest(request, before);
        return interceptedStream(effectiveRequest, before.context());
    }

    /**
     * 把底层流包装成可拦截的迭代器流。
     *
     * <p>每个增量块先累计正文/推理/工具调用/用量，再交给
     * {@code ON_MODEL_STREAM} 拦截；遇到终止块或流提前结束时，
     * 合成完整 {@link ModelResponse} 交给 {@code AFTER_MODEL}。</p>
     */
    private Stream<StreamChunk> interceptedStream(ModelCallRequest request, LoopContext context) {
        Iterator<StreamChunk> source;
        try {
            source = delegate.stream(request, context).iterator();
        } catch (RuntimeException exception) {
            InterceptionResult error = interceptors.run(
                InterceptPoint.ON_MODEL_ERROR,
                new InterceptContext(
                    InterceptPoint.ON_MODEL_ERROR,
                    null,
                    null,
                    context,
                    new ModelCallError(exception.getMessage(), exception)
                )
            );
            throwIfTerminal(error.decision());
            throw exception;
        }
        StringBuilder content = new StringBuilder();
        StringBuilder reasoning = new StringBuilder();
        List<site.sorghum.cutin.core.tool.ToolCall> toolCalls = new ArrayList<>();
        List<String> thinkingBlocks = new ArrayList<>();
        Usage[] usage = {Usage.ZERO};

        Iterator<StreamChunk> intercepted = new Iterator<>() {
            private boolean delivered;
            private StreamChunk pendingSynthetic;

            /** 已交付终止块后返回 false，否则继续看合成块或底层流。 */
            @Override
            public boolean hasNext() {
                if (delivered) {
                    return false;
                }
                try {
                    return pendingSynthetic != null || source.hasNext();
                } catch (RuntimeException exception) {
                    interceptModelError(context, exception);
                    throw exception;
                }
            }

            /** 返回下一个被拦截的增量块；底层流结束时合成终止块并执行 AFTER_MODEL。 */
            @Override
            public StreamChunk next() {
                if (!hasNext()) {
                    throw new NoSuchElementException();
                }
                if (pendingSynthetic != null) {
                    StreamChunk synthetic = pendingSynthetic;
                    pendingSynthetic = null;
                    delivered = true;
                    return synthetic;
                }

                StreamChunk chunk;
                try {
                    chunk = source.next();
                } catch (RuntimeException exception) {
                    interceptModelError(context, exception);
                    throw exception;
                }
                accumulate(chunk, content, reasoning, toolCalls, thinkingBlocks, usage);
                StreamChunk effective = interceptChunk(chunk, context);
                if (effective.terminal()) {
                    Object rawError = effective.metadata().get("error");
                    if (rawError != null) {
                        InterceptionResult error = interceptors.run(
                            InterceptPoint.ON_MODEL_ERROR,
                            new InterceptContext(
                                InterceptPoint.ON_MODEL_ERROR,
                                null,
                                null,
                                context,
                                new ModelCallError(String.valueOf(rawError), null)
                            )
                        );
                        throwIfTerminal(error.decision());
                    }
                    Map<String, Object> effectiveMetadata = effective.metadata();
                    String effectiveReasoning = reasoning.toString();
                    Object chunkReasoning = effectiveMetadata.get("reasoning_content");
                    if ((effectiveReasoning == null || effectiveReasoning.isEmpty()) && chunkReasoning != null) {
                        effectiveReasoning = String.valueOf(chunkReasoning);
                    }
                    if (!effectiveReasoning.isEmpty()) {
                        reasoning.setLength(0);
                        reasoning.append(effectiveReasoning);
                    }
                    ModelResponse response = response(
                        content.toString(),
                        effectiveReasoning,
                        toolCalls,
                        thinkingBlocks,
                        usage[0],
                        rawOf(effective),
                        exchangeOf(effective),
                        effectiveMetadata
                    );
                    InterceptionResult after = interceptors.run(
                        InterceptPoint.AFTER_MODEL,
                        new InterceptContext(InterceptPoint.AFTER_MODEL, null, null, context, response)
                    );
                    throwIfTerminal(after.decision());
                    if (after.payload() != response && after.payload() instanceof ModelResponse replacement) {
                        effective = terminalChunk(effective, replacement);
                    }
                    delivered = true;
                    return effective;
                }

                if (!hasNext()) {
                    StreamChunk terminal = new StreamChunk(
                        "",
                        null,
                        List.copyOf(toolCalls),
                        List.copyOf(thinkingBlocks),
                        usage[0],
                        Map.of(),
                        true
                    );
                    String fallbackReasoning = reasoning.toString();
                    Object fallbackChunkReasoning = effective.metadata().get("reasoning_content");
                    if ((fallbackReasoning == null || fallbackReasoning.isEmpty()) && fallbackChunkReasoning != null) {
                        fallbackReasoning = String.valueOf(fallbackChunkReasoning);
                    }
                    ModelResponse response = response(
                        content.toString(),
                        fallbackReasoning,
                        toolCalls,
                        thinkingBlocks,
                        usage[0],
                        rawOf(effective),
                        exchangeOf(effective),
                        effective.metadata()
                    );
                    InterceptionResult after = interceptors.run(
                        InterceptPoint.AFTER_MODEL,
                        new InterceptContext(InterceptPoint.AFTER_MODEL, null, null, context, response)
                    );
                    throwIfTerminal(after.decision());
                    pendingSynthetic = after.payload() != response && after.payload() instanceof ModelResponse replacement
                        ? terminalChunk(terminal, replacement)
                        : terminal;
                }
                return effective;
            }
        };
        return StreamSupport.stream(
            Spliterators.spliteratorUnknownSize(intercepted, Spliterator.ORDERED),
            false
        );
    }

    /** 将流创建、探测和读取阶段的异常统一交给模型错误拦截链。 */
    private void interceptModelError(LoopContext context, RuntimeException exception) {
        InterceptionResult error = interceptors.run(
            InterceptPoint.ON_MODEL_ERROR,
            new InterceptContext(
                InterceptPoint.ON_MODEL_ERROR,
                null,
                null,
                context,
                new ModelCallError(exception.getMessage(), exception)
            )
        );
        throwIfTerminal(error.decision());
    }

    /** 对单个增量块发布事件并执行 ON_MODEL_STREAM 拦截。 */
    private StreamChunk interceptChunk(StreamChunk chunk, LoopContext context) {
        events.emit(new LoopEvent(
            "ON_MODEL_STREAM",
            context.id(),
            null,
            Map.of(
                "text", chunk.content(),
                "reasoning", chunk.reasoning() == null ? "" : chunk.reasoning(),
                "terminal", chunk.terminal()
            )
        ));
        InterceptionResult stream = interceptors.run(
            InterceptPoint.ON_MODEL_STREAM,
            new InterceptContext(InterceptPoint.ON_MODEL_STREAM, null, null, context, chunk)
        );
        throwIfTerminal(stream.decision());
        return stream.payload() instanceof StreamChunk replacement ? replacement : chunk;
    }

    /** 把增量块中的内容、推理、工具调用、思考块与用量累计起来。 */
    private static void accumulate(
        StreamChunk chunk,
        StringBuilder content,
        StringBuilder reasoning,
        List<site.sorghum.cutin.core.tool.ToolCall> toolCalls,
        List<String> thinkingBlocks,
        Usage[] usage
    ) {
        if (chunk.content() != null) {
            content.append(chunk.content());
        }
        if (chunk.reasoning() != null) {
            reasoning.append(chunk.reasoning());
        }
        toolCalls.addAll(chunk.toolCalls());
        thinkingBlocks.addAll(chunk.thinkingBlocks());
        usage[0] = usage[0].add(chunk.usage());
    }

    /** 计算最终实际发给 Provider 的请求：优先使用 BEFORE_MODEL 的替换请求。 */
    private static ModelCallRequest effectiveRequest(
        ModelCallRequest original,
        InterceptionResult before
    ) {
        if (before.payload() != original && before.payload() instanceof ModelCallRequest replacement) {
            return replacement;
        }
        return new ModelCallRequest(
            original.modelId(),
            before.context().messages(),
            original.tools(),
            original.options()
        );
    }

    /** 把累计结果组装成 assistant 消息与元数据，并附带原始请求与响应体。 */
    private static ModelResponse response(
        String content,
        String reasoning,
        List<site.sorghum.cutin.core.tool.ToolCall> toolCalls,
        List<String> thinkingBlocks,
        Usage usage,
        String raw,
        ModelHttpExchange exchange
    ) {
        return response(content, reasoning, toolCalls, thinkingBlocks, usage, raw, exchange, Map.of());
    }

    private static ModelResponse response(
        String content,
        String reasoning,
        List<site.sorghum.cutin.core.tool.ToolCall> toolCalls,
        List<String> thinkingBlocks,
        Usage usage,
        String raw,
        ModelHttpExchange exchange,
        Map<String, Object> extraMetadata
    ) {
        Map<String, Object> metadata = new java.util.HashMap<>();
        if (reasoning != null && !reasoning.isEmpty()) {
            metadata.put("reasoning_content", reasoning);
        }
        if (thinkingBlocks != null && !thinkingBlocks.isEmpty()) {
            metadata.put("thinking_blocks", List.copyOf(thinkingBlocks));
        }
        if (extraMetadata != null) {
            Object responseReasoning = extraMetadata.get("response_reasoning");
            if (responseReasoning != null) {
                metadata.put("response_reasoning", String.valueOf(responseReasoning));
            }
        }
        return new ModelResponse(
            new Message("assistant", content, null, toolCalls, metadata),
            usage,
            true,
            raw,
            exchange
        );
    }

    /** 从终止块元数据中取出 provider 附带的原始响应体。 */
    private static String rawOf(StreamChunk terminal) {
        Object raw = terminal.metadata().get("raw");
        return raw == null ? "" : String.valueOf(raw);
    }

    private static ModelHttpExchange exchangeOf(StreamChunk terminal) {
        Object value = terminal.metadata().get("request");
        return value instanceof ModelHttpExchange exchange ? exchange : null;
    }

    /** 用 AFTER_MODEL 替换后的响应生成新的终止块，并把响应放入元数据。 */
    private static StreamChunk terminalChunk(StreamChunk terminal, ModelResponse replacement) {
        Map<String, Object> metadata = new java.util.HashMap<>(terminal.metadata());
        metadata.put("response", replacement);
        return new StreamChunk(
            replacement.message().content(),
            terminal.reasoning(),
            replacement.message().toolCalls(),
            terminal.thinkingBlocks(),
            replacement.usage(),
            terminal.phases(),
            metadata,
            true
        );
    }

    /** 将拦截决策转换为对应的控制流异常（重试、跳转、挂起、中止）。 */
    private void throwIfTerminal(InterceptDecision decision) {
        if (decision.isAbort()) {
            throw new LoopAbortException(decision.reason());
        }
        if (decision.isSuspend()) {
            throw new LoopSuspendException(decision.reason());
        }
        if (decision.isRetry()) {
            throw new LoopRetryException(decision.reason() == null ? "retry" : decision.reason());
        }
        if (decision.isGoto()) {
            throw new LoopGotoException(
                decision.targetNodeId(),
                decision.reason() == null ? "goto" : decision.reason()
            );
        }
    }
}
