package site.sorghum.cutin.integrations.model;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;
import site.sorghum.cutin.core.context.Message;
import site.sorghum.cutin.core.context.Usage;
import site.sorghum.cutin.core.json.JsonSupport;
import site.sorghum.cutin.core.model.ModelCallRequest;
import site.sorghum.cutin.core.model.ModelProvider;
import site.sorghum.cutin.core.model.ModelResponse;
import site.sorghum.cutin.core.model.ModelStreamPhase;
import site.sorghum.cutin.core.model.StreamChunk;
import site.sorghum.cutin.core.tool.ToolDefinition;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 真实协议 Provider 测试：用本地 HTTP 服务器验证三个 Provider 的
 * 请求映射、响应解析、流式增量、工具调用与用量统计。
 */
class RealModelProvidersTest {

    /** Chat Completions Provider 应正确映射请求、工具调用与用量。 */
    @Test
    void chatCompletionsProviderMapsRequestAndToolCalls() throws Exception {
        AtomicReference<String> requestBody = new AtomicReference<>();
        HttpServer server = server("/chat/completions", requestBody, """
            {
              "choices": [{"message": {
                "role": "assistant",
                "content": "hello",
              "tool_calls": [{"id": "call_1", "type": "function",
                  "function": {"name": "read", "arguments": "{\\"path\\":\\"a.txt\\"}"}}]
              }}],
              "usage": {"prompt_tokens": 10, "completion_tokens": 5,
                "prompt_tokens_details": {"cached_tokens": 6}}
            }
            """);
        server.start();
        try {
            ModelProviderConfig config = new ModelProviderConfig(
                "chat",
                "http://127.0.0.1:" + server.getAddress().getPort(),
                "key",
                "gpt-5",
                Map.of("maxTokens", 12345)
            );
            OpenAiChatCompletionsProvider provider = new OpenAiChatCompletionsProvider(config);
            ModelCallRequest request = new ModelCallRequest(
                "gpt-5",
                List.of(new Message("user", "hi").withMetadata("images", List.of("https://example.com/cat.png"))),
                List.of(new ToolDefinition("read", "Read a file", Map.of("type", "object"))),
                Map.of()
            );

            ModelResponse response = provider.call(request);

            ONode body = JsonSupport.read(requestBody.get());
            assertEquals("gpt-5", JsonSupport.text(body, "", "model"));
            assertFalse(JsonSupport.boolValue(body, false, "stream"));
            assertEquals(12345, JsonSupport.intValue(body, 0, "max_tokens"));
            assertEquals("text", JsonSupport.text(body, "", "messages", 0, "content", 0, "type"));
            assertEquals("hi", JsonSupport.text(body, "", "messages", 0, "content", 0, "text"));
            assertEquals("image_url", JsonSupport.text(body, "", "messages", 0, "content", 1, "type"));
            assertEquals("https://example.com/cat.png", JsonSupport.text(body, "", "messages", 0, "content", 1, "image_url", "url"));
            assertEquals("read", JsonSupport.text(body, "", "tools", 0, "function", "name"));
            assertEquals("hello", response.message().content());
            assertEquals(1, response.message().toolCalls().size());
            assertEquals("a.txt", response.message().toolCalls().get(0).arguments().get("path"));
            assertEquals(15, response.usage().totalTokens());
            assertEquals(6, response.usage().cacheReadTokens());
            assertEquals(4, response.usage().cacheMissTokens());
        } finally {
            server.stop(0);
        }
    }

    /** Responses Provider 应正确提取 instructions 并映射函数调用。 */
    @Test
    void responsesProviderMapsInstructionsAndFunctionCalls() throws Exception {
        AtomicReference<String> requestBody = new AtomicReference<>();
        HttpServer server = server("/responses", requestBody, """
            {
              "output": [
                {"type": "message", "content": [{"type": "output_text", "text": "hello"}]},
                {"type": "function_call", "id": "call_1", "call_id": "call_1",
                 "name": "read", "arguments": "{\\"path\\":\\"b.txt\\"}"}
              ],
              "usage": {"input_tokens": 12, "output_tokens": 4,
                "input_tokens_details": {"cached_tokens": 7}}
            }
            """);
        server.start();
        try {
            ModelProviderConfig config = new ModelProviderConfig(
                "responses",
                "http://127.0.0.1:" + server.getAddress().getPort(),
                "key",
                "gpt-5",
                Map.of("maxTokens", 23456)
            );
            OpenAiResponsesProvider provider = new OpenAiResponsesProvider(config);
            ModelCallRequest request = new ModelCallRequest(
                "gpt-5",
                List.of(
                    new Message("system", "be concise"),
                    new Message("user", "hi").withMetadata("images", List.of("https://example.com/cat.png"))
                ),
                List.of(),
                Map.of()
            );

            ModelResponse response = provider.call(request);

            ONode body = JsonSupport.read(requestBody.get());
            assertEquals(23456, JsonSupport.intValue(body, 0, "max_output_tokens"));
            assertEquals("be concise", JsonSupport.text(body, "", "instructions"));
            assertEquals("input_text", JsonSupport.text(body, "", "input", 0, "content", 0, "type"));
            assertEquals("hi", JsonSupport.text(body, "", "input", 0, "content", 0, "text"));
            assertEquals("input_image", JsonSupport.text(body, "", "input", 0, "content", 1, "type"));
            assertEquals("https://example.com/cat.png", JsonSupport.text(body, "", "input", 0, "content", 1, "image_url"));
            assertEquals("hello", response.message().content());
            assertEquals(1, response.message().toolCalls().size());
            assertEquals("b.txt", response.message().toolCalls().get(0).arguments().get("path"));
            assertEquals(16, response.usage().totalTokens());
            assertEquals(7, response.usage().cacheReadTokens());
            assertEquals(5, response.usage().cacheMissTokens());
        } finally {
            server.stop(0);
        }
    }

    /** Anthropic Provider 应正确映射 system、工具声明与 tool_use。 */
    @Test
    void anthropicProviderMapsSystemToolsAndToolUse() throws Exception {
        AtomicReference<String> requestBody = new AtomicReference<>();
        HttpServer server = server("/v1/messages", requestBody, """
            {
              "content": [
                {"type": "text", "text": "hello"},
                {"type": "tool_use", "id": "call_1", "name": "read",
                 "input": {"path": "c.txt"}}
              ],
              "usage": {"input_tokens": 8, "output_tokens": 7,
                "cache_read_input_tokens": 3, "cache_creation_input_tokens": 2}
            }
            """);
        server.start();
        try {
            ModelProviderConfig config = new ModelProviderConfig(
                "anthropic",
                "http://127.0.0.1:" + server.getAddress().getPort(),
                "key",
                "claude-4",
                Map.of()
            );
            AnthropicMessagesProvider provider = new AnthropicMessagesProvider(config);
            ModelCallRequest request = new ModelCallRequest(
                "claude-4",
                List.of(
                    new Message("system", "be concise"),
                    new Message("user", "hi").withMetadata("images", List.of("data:image/png;base64,aGVsbG8="))
                ),
                List.of(new ToolDefinition("read", "Read a file", Map.of("type", "object"))),
                Map.of()
            );

            ModelResponse response = provider.call(request);

            ONode body = JsonSupport.read(requestBody.get());
            assertEquals("claude-4", JsonSupport.text(body, "", "model"));
            assertEquals("be concise", JsonSupport.text(body, "", "system"));
            assertEquals("text", JsonSupport.text(body, "", "messages", 0, "content", 0, "type"));
            assertEquals("hi", JsonSupport.text(body, "", "messages", 0, "content", 0, "text"));
            assertEquals("image", JsonSupport.text(body, "", "messages", 0, "content", 1, "type"));
            assertEquals("base64", JsonSupport.text(body, "", "messages", 0, "content", 1, "source", "type"));
            assertEquals("image/png", JsonSupport.text(body, "", "messages", 0, "content", 1, "source", "media_type"));
            assertEquals("aGVsbG8=", JsonSupport.text(body, "", "messages", 0, "content", 1, "source", "data"));
            assertEquals("read", JsonSupport.text(body, "", "tools", 0, "name"));
            assertFalse(JsonSupport.boolValue(body, false, "stream"));
            assertEquals("hello", response.message().content());
            assertEquals(1, response.message().toolCalls().size());
            assertEquals("c.txt", response.message().toolCalls().get(0).arguments().get("path"));
            assertEquals(20, response.usage().totalTokens());
            assertEquals(13, response.usage().promptTokens());
            assertEquals(3, response.usage().cacheReadTokens());
            assertEquals(2, response.usage().cacheCreationTokens());
            assertEquals(10, response.usage().cacheMissTokens());
        } finally {
            server.stop(0);
        }
    }

    /** Chat Completions 流式调用应拼接正文增量。 */
    @Test
    void chatCompletionsProviderStreamsContent() throws Exception {
        AtomicReference<String> requestBody = new AtomicReference<>();
        HttpServer server = newStreamingServer("/chat/completions", requestBody);
        server.start();
        try {
            ModelProviderConfig config = new ModelProviderConfig(
                "chat",
                "http://127.0.0.1:" + server.getAddress().getPort(),
                "key",
                "gpt-5",
                Map.of()
            );
            OpenAiChatCompletionsProvider provider = new OpenAiChatCompletionsProvider(config);
            ModelCallRequest request = new ModelCallRequest(
                "gpt-5",
                List.of(new Message("user", "hi")),
                List.of(),
                Map.of()
            );

            String content;
            try (Stream<StreamChunk> chunks = provider.stream(request)) {
                content = chunks.map(StreamChunk::content).reduce("", String::concat);
            }

            assertEquals("hello", content);
            assertTrue(JsonSupport.boolValue(JsonSupport.read(requestBody.get()), false, "stream"));
        } finally {
            server.stop(0);
        }
    }

    /** Chat Completions 流式调用应只交付一次用量并聚合完整工具调用。 */
    @Test
    void chatCompletionsProviderStreamsToolCallsAndUsageOnce() throws Exception {
        AtomicReference<String> requestBody = new AtomicReference<>();
        HttpServer server = streamingServer("/chat/completions", requestBody, """
            data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}

            data: {"choices":[{"delta":{"content":"hello"}}]}

            data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":4}}}

            data: [DONE]

            """);
        server.start();
        try {
            ModelProviderConfig config = new ModelProviderConfig(
                "chat",
                "http://127.0.0.1:" + server.getAddress().getPort(),
                "key",
                "gpt-5",
                Map.of()
            );
            OpenAiChatCompletionsProvider provider = new OpenAiChatCompletionsProvider(config);
            ModelCallRequest request = new ModelCallRequest(
                "gpt-5",
                List.of(new Message("user", "hi")),
                List.of(),
                Map.of()
            );

            StringBuilder content = new StringBuilder();
            AtomicInteger usageChunks = new AtomicInteger();
            Usage[] totalUsage = {Usage.ZERO};
            AtomicReference<StreamChunk> last = new AtomicReference<>();
            try (Stream<StreamChunk> chunks = provider.stream(request)) {
                chunks.forEach(chunk -> {
                    if (chunk.content() != null) {
                        content.append(chunk.content());
                    }
                    if (chunk.usage().totalTokens() > 0) {
                        usageChunks.incrementAndGet();
                    }
                    totalUsage[0] = totalUsage[0].add(chunk.usage());
                    last.set(chunk);
                });
            }

            assertEquals("hello", content.toString());
            assertEquals(1, usageChunks.get());
            assertEquals(15, totalUsage[0].totalTokens());
            assertEquals(4, totalUsage[0].cacheReadTokens());
            assertEquals(6, totalUsage[0].cacheMissTokens());
            assertEquals(1, last.get().toolCalls().size(), () -> "last=" + last.get());
            assertEquals("read", last.get().toolCalls().get(0).toolId());
            assertEquals("a.txt", last.get().toolCalls().get(0).arguments().get("path"));
        } finally {
            server.stop(0);
        }
    }

    /** Chat Completions 流若逐块携带累计 usage（OpenRouter 等网关行为），应取末值而非反复累加。 */
    @Test
    void chatCompletionsProviderTakesLastUsageWhenRepeated() throws Exception {
        AtomicReference<String> requestBody = new AtomicReference<>();
        HttpServer server = streamingServer("/chat/completions", requestBody, """
            data: {"choices":[{"delta":{"content":"hel"}}],"usage":{"prompt_tokens":10,"completion_tokens":1}}

            data: {"choices":[{"delta":{"content":"lo"}}],"usage":{"prompt_tokens":11,"completion_tokens":2}}

            data: {"choices":[{"delta":{"content":" world"}}],"usage":{"prompt_tokens":12,"completion_tokens":3}}

            data: [DONE]

            """);
        server.start();
        try {
            ModelProviderConfig config = new ModelProviderConfig(
                "chat",
                "http://127.0.0.1:" + server.getAddress().getPort(),
                "key",
                "gpt-5",
                Map.of()
            );
            OpenAiChatCompletionsProvider provider = new OpenAiChatCompletionsProvider(config);
            ModelCallRequest request = new ModelCallRequest(
                "gpt-5",
                List.of(new Message("user", "hi")),
                List.of(),
                Map.of()
            );

            StringBuilder content = new StringBuilder();
            AtomicInteger usageChunks = new AtomicInteger();
            Usage[] totalUsage = {Usage.ZERO};
            try (Stream<StreamChunk> chunks = provider.stream(request)) {
                chunks.forEach(chunk -> {
                    if (chunk.content() != null) {
                        content.append(chunk.content());
                    }
                    if (chunk.usage().totalTokens() > 0) {
                        usageChunks.incrementAndGet();
                    }
                    totalUsage[0] = totalUsage[0].add(chunk.usage());
                });
            }

            assertEquals("hello world", content.toString());
            assertEquals(1, usageChunks.get());
            assertEquals(12, totalUsage[0].promptTokens());
            assertEquals(3, totalUsage[0].completionTokens());
            assertEquals(15, totalUsage[0].totalTokens());
        } finally {
            server.stop(0);
        }
    }

    /** llama.cpp 风格的 timings 应转换为统一 Usage，并保留缓存命中明细。 */
    @Test
    void chatCompletionsProviderMapsLlamaCppTimingsUsage() throws Exception {
        AtomicReference<String> requestBody = new AtomicReference<>();
        HttpServer server = streamingServer("/chat/completions", requestBody, """
            data: {"choices":[{"finish_reason":"tool_calls","index":0,"delta":{}}],"created":1787109007,"id":"chatcmpl-1","model":"Qwen3.8","object":"chat.completion.chunk","timings":{"cache_n":23058,"prompt_n":4,"prompt_ms":110.645,"predicted_n":482,"predicted_ms":30127.483}}

            data: [DONE]

            """);
        server.start();
        try {
            ModelProviderConfig config = new ModelProviderConfig(
                "chat",
                "http://127.0.0.1:" + server.getAddress().getPort(),
                "key",
                "Qwen3.8",
                Map.of()
            );
            OpenAiChatCompletionsProvider provider = new OpenAiChatCompletionsProvider(config);
            ModelCallRequest request = new ModelCallRequest(
                "Qwen3.8",
                List.of(new Message("user", "hi")),
                List.of(),
                Map.of()
            );

            Usage total = Usage.ZERO;
            try (Stream<StreamChunk> chunks = provider.stream(request)) {
                total = chunks.map(StreamChunk::usage).reduce(Usage.ZERO, Usage::add);
            }

            assertEquals(23062, total.promptTokens());
            assertEquals(482, total.completionTokens());
            assertEquals(23058, total.cacheReadTokens());
            assertEquals(4, total.cacheMissTokens());
            assertEquals(23544, total.totalTokens());
        } finally {
            server.stop(0);
        }
    }

    /** Ollama 原生最终响应的计数字段应转换为统一 Usage。 */
    @Test
    void chatCompletionsProviderMapsOllamaUsage() throws Exception {
        AtomicReference<String> requestBody = new AtomicReference<>();
        HttpServer server = streamingServer("/chat/completions", requestBody, """
            data: {"model":"qwen3","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":23062,"eval_count":482,"prompt_eval_duration":110645000,"eval_duration":30127483000}

            data: [DONE]

            """);
        server.start();
        try {
            ModelProviderConfig config = new ModelProviderConfig(
                "chat",
                "http://127.0.0.1:" + server.getAddress().getPort(),
                "key",
                "qwen3",
                Map.of()
            );
            OpenAiChatCompletionsProvider provider = new OpenAiChatCompletionsProvider(config);
            ModelCallRequest request = new ModelCallRequest(
                "qwen3",
                List.of(new Message("user", "hi")),
                List.of(),
                Map.of()
            );

            Usage total;
            try (Stream<StreamChunk> chunks = provider.stream(request)) {
                total = chunks.map(StreamChunk::usage).reduce(Usage.ZERO, Usage::add);
            }

            assertEquals(23062, total.promptTokens());
            assertEquals(482, total.completionTokens());
            assertEquals(0, total.cacheReadTokens());
            assertEquals(23062, total.cacheMissTokens());
            assertEquals(23544, total.totalTokens());
        } finally {
            server.stop(0);
        }
    }

    /** Responses 流式调用应只交付一次用量并聚合完整函数调用。 */
    @Test
    void responsesProviderStreamsFunctionCallAndUsageOnce() throws Exception {
        AtomicReference<String> requestBody = new AtomicReference<>();
        HttpServer server = streamingServer("/responses", requestBody, """
            data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"call_1","call_id":"call_1","name":"read","arguments":""}}

            data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"path\\":\\"b.txt\\"}"}

            data: {"type":"response.function_call_arguments.done","output_index":0,"arguments":"{\\"path\\":\\"b.txt\\"}"}

            data: {"type":"response.output_text.delta","delta":"hello"}

            data: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":4,"input_tokens_details":{"cached_tokens":7}}}}

            data: [DONE]

            """);
        server.start();
        try {
            ModelProviderConfig config = new ModelProviderConfig(
                "responses",
                "http://127.0.0.1:" + server.getAddress().getPort(),
                "key",
                "gpt-5",
                Map.of()
            );
            OpenAiResponsesProvider provider = new OpenAiResponsesProvider(config);
            ModelCallRequest request = new ModelCallRequest(
                "gpt-5",
                List.of(new Message("user", "hi")),
                List.of(),
                Map.of()
            );

            StringBuilder content = new StringBuilder();
            AtomicInteger usageChunks = new AtomicInteger();
            Usage[] totalUsage = {Usage.ZERO};
            AtomicReference<StreamChunk> last = new AtomicReference<>();
            try (Stream<StreamChunk> chunks = provider.stream(request)) {
                chunks.forEach(chunk -> {
                    if (chunk.content() != null) {
                        content.append(chunk.content());
                    }
                    if (chunk.usage().totalTokens() > 0) {
                        usageChunks.incrementAndGet();
                    }
                    totalUsage[0] = totalUsage[0].add(chunk.usage());
                    last.set(chunk);
                });
            }

            assertEquals("hello", content.toString());
            assertEquals(1, usageChunks.get());
            assertEquals(16, totalUsage[0].totalTokens());
            assertEquals(7, totalUsage[0].cacheReadTokens());
            assertEquals(5, totalUsage[0].cacheMissTokens());
            assertEquals(1, last.get().toolCalls().size(), () -> "last=" + last.get());
            assertEquals("read", last.get().toolCalls().get(0).toolId());
            assertEquals("b.txt", last.get().toolCalls().get(0).arguments().get("path"));
        } finally {
            server.stop(0);
        }
    }

    /** Responses 应立即暴露思考开始阶段，但不把密文放进增量内容。 */
    @Test
    void responsesProviderMarksReasoningStartedWithoutExposingCiphertext() throws Exception {
        AtomicReference<String> requestBody = new AtomicReference<>();
        HttpServer server = streamingServer("/responses", requestBody, """
            data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[]}}

            data: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_1","encrypted_content":"secret-ciphertext","summary":[]}}

            data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":3}}}

            data: [DONE]

            """);
        server.start();
        try {
            ModelProviderConfig config = new ModelProviderConfig(
                "responses",
                "http://127.0.0.1:" + server.getAddress().getPort(),
                "key",
                "gpt-5",
                Map.of()
            );
            OpenAiResponsesProvider provider = new OpenAiResponsesProvider(config);
            ModelCallRequest request = new ModelCallRequest(
                "gpt-5",
                List.of(new Message("user", "hi")),
                List.of(),
                Map.of("reasoningEffort", "high")
            );

            List<StreamChunk> chunks;
            try (Stream<StreamChunk> stream = provider.stream(request)) {
                chunks = stream.toList();
            }

            assertTrue(chunks.stream().anyMatch(chunk ->
                chunk.phases().contains(ModelStreamPhase.REASONING_STARTED)));
            assertEquals(1, chunks.stream().filter(chunk ->
                chunk.phases().contains(ModelStreamPhase.REASONING_STARTED)).count());
            assertTrue(chunks.get(0).phases().contains(ModelStreamPhase.REASONING_STARTED),
                "思考开始阶段应在 reasoning item added 时立即交付");
            assertTrue(chunks.stream().noneMatch(chunk ->
                String.valueOf(chunk.content()).contains("secret-ciphertext")
                    || String.valueOf(chunk.reasoning()).contains("secret-ciphertext")));
            assertEquals("reasoning.encrypted_content",
                JsonSupport.text(JsonSupport.read(requestBody.get()), "", "include", 0));
        } finally {
            server.stop(0);
        }
    }

    /** Responses 流式摘要应仅通过增量交付，terminal 块不得重复携带全文。 */
    @Test
    void responsesProviderDoesNotRepeatSummaryAtStreamEnd() throws Exception {
        AtomicReference<String> requestBody = new AtomicReference<>();
        HttpServer server = streamingServer("/responses", requestBody, """
            data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[]}}

            data: {"type":"response.reasoning_summary_text.delta","item_id":"rs_1","output_index":0,"summary_index":0,"delta":"let me"}

            data: {"type":"response.reasoning_summary_text.delta","item_id":"rs_1","output_index":0,"summary_index":0,"delta":" think"}

            data: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_1","summary":[{"type":"summary_text","text":"let me think"}]}}

            data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":3}}}

            data: [DONE]

            """);
        server.start();
        try {
            ModelProviderConfig config = new ModelProviderConfig(
                "responses",
                "http://127.0.0.1:" + server.getAddress().getPort(),
                "key",
                "gpt-5",
                Map.of()
            );
            OpenAiResponsesProvider provider = new OpenAiResponsesProvider(config);
            ModelCallRequest request = new ModelCallRequest(
                "gpt-5",
                List.of(new Message("user", "hi")),
                List.of(),
                Map.of("reasoningEffort", "high")
            );

            List<StreamChunk> chunks;
            try (Stream<StreamChunk> stream = provider.stream(request)) {
                chunks = stream.toList();
            }

            StreamChunk terminal = chunks.get(chunks.size() - 1);
            assertTrue(terminal.terminal());
            assertNull(terminal.reasoning(), "增量已交付过摘要，terminal 不应重复携带全文");
            StringBuilder streamed = new StringBuilder();
            for (StreamChunk chunk : chunks) {
                if (!chunk.terminal() && chunk.reasoning() != null) {
                    streamed.append(chunk.reasoning());
                }
            }
            assertEquals("let me think", streamed.toString(), "摘要应仅通过增量交付一次");
        } finally {
            server.stop(0);
        }
    }

    /** Chat Completions 应在首个 reasoning delta 前交付通用推理开始阶段。 */
    @Test
    void chatCompletionsProviderMarksReasoningStartedOnce() throws Exception {
        AtomicReference<String> requestBody = new AtomicReference<>();
        HttpServer server = streamingServer("/chat/completions", requestBody, """
            data: {"choices":[{"delta":{"reasoning_content":"先分析"}}]}

            data: {"choices":[{"delta":{"reasoning_content":"再处理"}}]}

            data: {"choices":[{"delta":{"content":"完成"}}]}

            data: [DONE]

            """);
        server.start();
        try {
            ModelProviderConfig config = new ModelProviderConfig(
                "chat", "http://127.0.0.1:" + server.getAddress().getPort(),
                "key", "reasoning-model", Map.of()
            );
            OpenAiChatCompletionsProvider provider = new OpenAiChatCompletionsProvider(config);
            List<StreamChunk> chunks;
            try (Stream<StreamChunk> stream = provider.stream(new ModelCallRequest(
                "reasoning-model", List.of(new Message("user", "hi")), List.of(), Map.of()))) {
                chunks = stream.toList();
            }

            assertEquals(1, chunks.stream().filter(chunk ->
                chunk.phases().contains(ModelStreamPhase.REASONING_STARTED)).count());
            assertTrue(chunks.get(0).phases().contains(ModelStreamPhase.REASONING_STARTED));
            assertEquals("先分析", chunks.get(1).reasoning());
        } finally {
            server.stop(0);
        }
    }

    /** Anthropic 应在 thinking block start 时立即交付通用推理开始阶段。 */
    @Test
    void anthropicProviderMarksReasoningStartedAtBlockStart() throws Exception {
        AtomicReference<String> requestBody = new AtomicReference<>();
        HttpServer server = streamingServer("/v1/messages", requestBody, """
            data: {"type":"message_start","message":{"usage":{"input_tokens":2,"output_tokens":0}}}

            data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}

            data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"先分析"}}

            data: {"type":"content_block_stop","index":0}

            data: {"type":"message_stop"}

            """);
        server.start();
        try {
            ModelProviderConfig config = new ModelProviderConfig(
                "anthropic", "http://127.0.0.1:" + server.getAddress().getPort(),
                "key", "claude", Map.of()
            );
            AnthropicMessagesProvider provider = new AnthropicMessagesProvider(config);
            List<StreamChunk> chunks;
            try (Stream<StreamChunk> stream = provider.stream(new ModelCallRequest(
                "claude", List.of(new Message("user", "hi")), List.of(), Map.of()))) {
                chunks = stream.toList();
            }

            assertEquals(1, chunks.stream().filter(chunk ->
                chunk.phases().contains(ModelStreamPhase.REASONING_STARTED)).count());
            assertTrue(chunks.get(0).phases().contains(ModelStreamPhase.REASONING_STARTED));
            assertEquals("先分析", chunks.get(1).reasoning());
        } finally {
            server.stop(0);
        }
    }

    /** Anthropic 流式调用应聚合 thinking、工具调用并只交付一次用量。 */
    @Test
    void anthropicProviderStreamsThinkingToolUseAndUsageOnce() throws Exception {
        AtomicReference<String> requestBody = new AtomicReference<>();
        HttpServer server = streamingServer("/v1/messages", requestBody, """
            data: {"type":"message_start","message":{"usage":{"input_tokens":8,"output_tokens":0,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}}

            data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"let me","signature":""}}

            data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" think"}}

            data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig123"}}

            data: {"type":"content_block_stop","index":0}

            data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call_1","name":"read","input":{}}}

            data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"c.txt\\"}"}}

            data: {"type":"content_block_stop","index":1}

            data: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"hello"}}

            data: {"type":"message_delta","usage":{"output_tokens":7}}

            data: {"type":"message_stop"}

            data: [DONE]

            """);
        server.start();
        try {
            ModelProviderConfig config = new ModelProviderConfig(
                "anthropic",
                "http://127.0.0.1:" + server.getAddress().getPort(),
                "key",
                "claude-4",
                Map.of()
            );
            AnthropicMessagesProvider provider = new AnthropicMessagesProvider(config);
            ModelCallRequest request = new ModelCallRequest(
                "claude-4",
                List.of(new Message("user", "hi")),
                List.of(),
                Map.of()
            );

            StringBuilder content = new StringBuilder();
            AtomicInteger usageChunks = new AtomicInteger();
            Usage[] totalUsage = {Usage.ZERO};
            AtomicReference<StreamChunk> last = new AtomicReference<>();
            try (Stream<StreamChunk> chunks = provider.stream(request)) {
                chunks.forEach(chunk -> {
                    if (chunk.content() != null) {
                        content.append(chunk.content());
                    }
                    if (chunk.usage().totalTokens() > 0) {
                        usageChunks.incrementAndGet();
                    }
                    totalUsage[0] = totalUsage[0].add(chunk.usage());
                    last.set(chunk);
                });
            }

            assertEquals("hello", content.toString());
            assertEquals(1, usageChunks.get());
            assertEquals(20, totalUsage[0].totalTokens());
            assertEquals(3, totalUsage[0].cacheReadTokens());
            assertEquals(2, totalUsage[0].cacheCreationTokens());
            assertEquals(10, totalUsage[0].cacheMissTokens());
            assertEquals(1, last.get().thinkingBlocks().size());
            assertTrue(last.get().thinkingBlocks().get(0).contains("let me think"));
            assertTrue(last.get().thinkingBlocks().get(0).contains("sig123"));
            assertEquals(1, last.get().toolCalls().size(), () -> "last=" + last.get());
            assertEquals("read", last.get().toolCalls().get(0).toolId());
            assertEquals("c.txt", last.get().toolCalls().get(0).arguments().get("path"));
        } finally {
            server.stop(0);
        }
    }

    /** ProviderInterceptor 可检查上下文并就地修改请求体（同步调用）。 */
    @Test
    void providerInterceptorCanInspectAndModifyBody() throws Exception {
        AtomicReference<String> requestBody = new AtomicReference<>();
        AtomicReference<ModelProvider> seenProvider = new AtomicReference<>();
        AtomicReference<String> seenProviderId = new AtomicReference<>();
        AtomicReference<String> seenModel = new AtomicReference<>();
        ProviderInterceptor interceptor = context -> {
            seenProvider.set(context.provider());
            seenProviderId.set(context.providerId());
            seenModel.set(context.modelId());
            assertEquals("chat", context.providerId());
            assertEquals("gpt-5", context.request().modelId());
            assertNotNull(context.body());
            context.body().set("temperature", 0.2);
            context.body().set("extra_field", "injected");
            return null;
        };
        ProviderInterceptor.register(interceptor);
        HttpServer server = server("/chat/completions", requestBody, """
            {"choices": [{"message": {"role": "assistant", "content": "hello"}}],
             "usage": {"prompt_tokens": 1, "completion_tokens": 1}}
            """);
        server.start();
        try {
            ModelProviderConfig config = new ModelProviderConfig(
                "chat",
                "http://127.0.0.1:" + server.getAddress().getPort(),
                "key",
                "gpt-5",
                Map.of()
            );
            OpenAiChatCompletionsProvider provider = new OpenAiChatCompletionsProvider(config);
            ModelCallRequest request = new ModelCallRequest(
                "gpt-5",
                List.of(new Message("user", "hi")),
                List.of(),
                Map.of()
            );

            ModelResponse response = provider.call(request);

            assertEquals("hello", response.message().content());
            assertSame(provider, seenProvider.get());
            assertEquals("chat", seenProviderId.get());
            assertEquals("gpt-5", seenModel.get());
            ONode body = JsonSupport.read(requestBody.get());
            assertEquals(0.2, JsonSupport.child(body, "temperature").getDouble(), 0.0001);
            assertEquals("injected", JsonSupport.text(body, "", "extra_field"));
            assertEquals("gpt-5", JsonSupport.text(body, "", "model"));
        } finally {
            ProviderInterceptor.unregister(interceptor);
            server.stop(0);
        }
    }

    /** ProviderInterceptor 也可以在每次 Provider 请求发送前修改请求头。 */
    @Test
    void providerInterceptorCanModifyHeaders() throws Exception {
        AtomicReference<String> requestHeader = new AtomicReference<>();
        ProviderInterceptor interceptor = new ProviderInterceptor() {
            @Override
            public ONode intercept(ProviderInterceptContext context) {
                return null;
            }

            @Override
            public void interceptHeaders(ProviderInterceptContext context) {
                assertNull(context.body());
                assertNotNull(context.request());
                assertEquals("gpt-5", context.modelId());
                context.headers().put("x-test-header", "injected");
            }
        };
        ProviderInterceptor.register(interceptor);
        HttpServer server = HttpServer.create(new InetSocketAddress(0), 0);
        server.createContext("/chat/completions", exchange -> {
            requestHeader.set(exchange.getRequestHeaders().getFirst("x-test-header"));
            exchange.getRequestBody().readAllBytes();
            byte[] response = "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"hello\"}}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1}}"
                .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        server.start();
        try {
            ModelProviderConfig config = new ModelProviderConfig(
                "chat",
                "http://127.0.0.1:" + server.getAddress().getPort(),
                "key",
                "gpt-5",
                Map.of()
            );
            OpenAiChatCompletionsProvider provider = new OpenAiChatCompletionsProvider(config);
            provider.call(new ModelCallRequest(
                "gpt-5",
                List.of(new Message("user", "hi")),
                List.of(),
                Map.of()
            ));

            assertEquals("injected", requestHeader.get());
        } finally {
            ProviderInterceptor.unregister(interceptor);
            server.stop(0);
        }
    }

    /** ProviderInterceptor 返回新节点时应整体替换请求体（同步调用）。 */
    @Test
    void providerInterceptorCanReplaceBody() throws Exception {
        AtomicReference<String> requestBody = new AtomicReference<>();
        ProviderInterceptor interceptor = context -> {
            ONode replacement = JsonSupport.object();
            replacement.set("model", JsonSupport.text(context.body(), "", "model"));
            replacement.set("stream", false);
            replacement.set("injected", "replaced");
            return replacement;
        };
        ProviderInterceptor.register(interceptor);
        HttpServer server = server("/chat/completions", requestBody, """
            {"choices": [{"message": {"role": "assistant", "content": "hello"}}],
             "usage": {"prompt_tokens": 1, "completion_tokens": 1}}
            """);
        server.start();
        try {
            ModelProviderConfig config = new ModelProviderConfig(
                "chat",
                "http://127.0.0.1:" + server.getAddress().getPort(),
                "key",
                "gpt-5",
                Map.of()
            );
            OpenAiChatCompletionsProvider provider = new OpenAiChatCompletionsProvider(config);
            ModelCallRequest request = new ModelCallRequest(
                "gpt-5",
                List.of(new Message("user", "hi")),
                List.of(),
                Map.of()
            );

            provider.call(request);

            ONode body = JsonSupport.read(requestBody.get());
            assertEquals("gpt-5", JsonSupport.text(body, "", "model"));
            assertEquals("replaced", JsonSupport.text(body, "", "injected"));
            assertNull(JsonSupport.child(body, "messages"));
        } finally {
            ProviderInterceptor.unregister(interceptor);
            server.stop(0);
        }
    }

    /** ProviderInterceptor 对流式调用同样生效，注入字段应出现在发送的请求体中。 */
    @Test
    void providerInterceptorAppliesToStreaming() throws Exception {
        AtomicReference<String> requestBody = new AtomicReference<>();
        ProviderInterceptor interceptor = context -> {
            context.body().set("max_tokens", 123);
            return null;
        };
        ProviderInterceptor.register(interceptor);
        HttpServer server = newStreamingServer("/chat/completions", requestBody);
        server.start();
        try {
            ModelProviderConfig config = new ModelProviderConfig(
                "chat",
                "http://127.0.0.1:" + server.getAddress().getPort(),
                "key",
                "gpt-5",
                Map.of()
            );
            OpenAiChatCompletionsProvider provider = new OpenAiChatCompletionsProvider(config);
            ModelCallRequest request = new ModelCallRequest(
                "gpt-5",
                List.of(new Message("user", "hi")),
                List.of(),
                Map.of()
            );

            String content;
            try (Stream<StreamChunk> chunks = provider.stream(request)) {
                content = chunks.map(StreamChunk::content).reduce("", String::concat);
            }

            assertEquals("hello", content);
            ONode body = JsonSupport.read(requestBody.get());
            assertTrue(JsonSupport.boolValue(body, false, "stream"));
            assertEquals(123, JsonSupport.intValue(body, 0, "max_tokens"));
        } finally {
            ProviderInterceptor.unregister(interceptor);
            server.stop(0);
        }
    }

    /** 拦截链按注册顺序执行，后一个拦截器能看到前一个的修改。 */
    @Test
    void providerInterceptorChainRunsInOrder() throws Exception {
        AtomicReference<String> requestBody = new AtomicReference<>();
        ProviderInterceptor first = context -> {
            context.body().set("hop", 1);
            return null;
        };
        ProviderInterceptor second = context -> {
            context.body().set("hop2", JsonSupport.intValue(context.body(), 0, "hop") + 1);
            return null;
        };
        ProviderInterceptor.register(first);
        ProviderInterceptor.register(second);
        HttpServer server = server("/chat/completions", requestBody, """
            {"choices": [{"message": {"role": "assistant", "content": "hello"}}],
             "usage": {"prompt_tokens": 1, "completion_tokens": 1}}
            """);
        server.start();
        try {
            ModelProviderConfig config = new ModelProviderConfig(
                "chat",
                "http://127.0.0.1:" + server.getAddress().getPort(),
                "key",
                "gpt-5",
                Map.of()
            );
            OpenAiChatCompletionsProvider provider = new OpenAiChatCompletionsProvider(config);
            ModelCallRequest request = new ModelCallRequest(
                "gpt-5",
                List.of(new Message("user", "hi")),
                List.of(),
                Map.of()
            );

            provider.call(request);

            ONode body = JsonSupport.read(requestBody.get());
            assertEquals(1, JsonSupport.intValue(body, 0, "hop"));
            assertEquals(2, JsonSupport.intValue(body, 0, "hop2"));
        } finally {
            ProviderInterceptor.unregister(first);
            ProviderInterceptor.unregister(second);
            server.stop(0);
        }
    }

    /** 注销拦截器后不再生效，避免跨调用、跨测试污染。 */
    @Test
    void providerInterceptorUnregisterStopsInterception() throws Exception {
        AtomicReference<String> requestBody = new AtomicReference<>();
        ProviderInterceptor interceptor = context -> {
            context.body().set("injected", "leaked");
            return null;
        };
        ProviderInterceptor.register(interceptor);
        HttpServer server = server("/chat/completions", requestBody, """
            {"choices": [{"message": {"role": "assistant", "content": "hello"}}],
             "usage": {"prompt_tokens": 1, "completion_tokens": 1}}
            """);
        server.start();
        try {
            ModelProviderConfig config = new ModelProviderConfig(
                "chat",
                "http://127.0.0.1:" + server.getAddress().getPort(),
                "key",
                "gpt-5",
                Map.of()
            );
            OpenAiChatCompletionsProvider provider = new OpenAiChatCompletionsProvider(config);
            ModelCallRequest request = new ModelCallRequest(
                "gpt-5",
                List.of(new Message("user", "hi")),
                List.of(),
                Map.of()
            );

            provider.call(request);
            assertEquals("leaked", JsonSupport.text(JsonSupport.read(requestBody.get()), "", "injected"));

            assertTrue(ProviderInterceptor.unregister(interceptor));
            provider.call(request);
            assertNull(JsonSupport.child(JsonSupport.read(requestBody.get()), "injected"));
        } finally {
            ProviderInterceptor.unregister(interceptor);
            server.stop(0);
        }
    }

    /** 请求未指定模型时，context.modelId() 回退到 Provider 默认模型。 */
    @Test
    void providerInterceptorModelIdFallsBackToConfig() throws Exception {
        AtomicReference<String> requestBody = new AtomicReference<>();
        AtomicReference<String> seenModel = new AtomicReference<>();
        ProviderInterceptor interceptor = context -> {
            seenModel.set(context.modelId());
            return null;
        };
        ProviderInterceptor.register(interceptor);
        HttpServer server = server("/chat/completions", requestBody, """
            {"choices": [{"message": {"role": "assistant", "content": "hello"}}],
             "usage": {"prompt_tokens": 1, "completion_tokens": 1}}
            """);
        server.start();
        try {
            ModelProviderConfig config = new ModelProviderConfig(
                "chat",
                "http://127.0.0.1:" + server.getAddress().getPort(),
                "key",
                "gpt-5",
                Map.of()
            );
            OpenAiChatCompletionsProvider provider = new OpenAiChatCompletionsProvider(config);
            ModelCallRequest request = new ModelCallRequest(
                "",
                List.of(new Message("user", "hi")),
                List.of(),
                Map.of()
            );

            provider.call(request);

            assertEquals("gpt-5", seenModel.get());
            ONode body = JsonSupport.read(requestBody.get());
            assertEquals("gpt-5", JsonSupport.text(body, "", "model"));
        } finally {
            ProviderInterceptor.unregister(interceptor);
            server.stop(0);
        }
    }

    /** 拦截器抛出异常会直接中断本次模型调用。 */
    @Test
    void providerInterceptorExceptionAbortsCall() throws Exception {
        AtomicReference<String> requestBody = new AtomicReference<>();
        ProviderInterceptor interceptor = context -> {
            throw new IllegalStateException("interceptor boom");
        };
        ProviderInterceptor.register(interceptor);
        HttpServer server = server("/chat/completions", requestBody, """
            {"choices": [{"message": {"role": "assistant", "content": "hello"}}],
             "usage": {"prompt_tokens": 1, "completion_tokens": 1}}
            """);
        server.start();
        try {
            ModelProviderConfig config = new ModelProviderConfig(
                "chat",
                "http://127.0.0.1:" + server.getAddress().getPort(),
                "key",
                "gpt-5",
                Map.of()
            );
            OpenAiChatCompletionsProvider provider = new OpenAiChatCompletionsProvider(config);
            ModelCallRequest request = new ModelCallRequest(
                "gpt-5",
                List.of(new Message("user", "hi")),
                List.of(),
                Map.of()
            );

            assertThrows(IllegalStateException.class, () -> provider.call(request));
            assertNull(requestBody.get(), "请求体不应发出到服务器");
        } finally {
            ProviderInterceptor.unregister(interceptor);
            server.stop(0);
        }
    }

    /** 创建返回固定 JSON 的普通 HTTP 服务器。 */
    private HttpServer server(String path, AtomicReference<String> requestBody, String response) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress(0), 0);
        server.createContext(path, exchange -> {
            try {
                respondJson(exchange, requestBody, response);
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
        return server;
    }

    /** 创建返回 SSE 流的 HTTP 服务器。 */
    private HttpServer streamingServer(String path, AtomicReference<String> requestBody, String body) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress(0), 0);
        server.createContext(path, exchange -> {
            try {
                requestBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().add("Content-Type", "text/event-stream");
                exchange.sendResponseHeaders(200, bytes.length);
                exchange.getResponseBody().write(bytes);
                exchange.close();
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
        return server;
    }

    /** 创建返回固定 SSE 流的 HTTP 服务器。 */
    private HttpServer newStreamingServer(String path, AtomicReference<String> requestBody) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress(0), 0);
        server.createContext(path, exchange -> {
            requestBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] body = ("data: {\"choices\":[{\"delta\":{\"content\":\"he\"}}]}\n\n"
                + "data: {\"choices\":[{\"delta\":{\"content\":\"llo\"}}]}\n\n"
                + "data: [DONE]\n\n").getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        return server;
    }

    /** 统一响应 JSON：记录请求体、设置 Content-Type 并返回响应内容。 */
    private static void respondJson(HttpExchange exchange, AtomicReference<String> requestBody, String response)
        throws Exception {
        requestBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
        byte[] body = response.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "application/json");
        exchange.sendResponseHeaders(200, body.length);
        exchange.getResponseBody().write(body);
        exchange.close();
    }
}
