package site.sorghum.loopra.bin.model;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import site.sorghum.cutin.core.context.Message;
import site.sorghum.cutin.core.json.JsonSupport;
import site.sorghum.cutin.core.model.ModelCallRequest;
import site.sorghum.cutin.integrations.model.AnthropicMessagesProvider;
import site.sorghum.cutin.integrations.model.OpenAiChatCompletionsProvider;
import site.sorghum.cutin.integrations.model.OpenAiResponsesProvider;
import site.sorghum.cutin.integrations.model.ProviderInterceptor;
import site.sorghum.loopra.bin.model.special.OpenCodeProviderInterceptor;

import java.util.List;
import java.util.Map;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * LoopraModelProvider 直接实现 cutin ModelProvider 后的核心行为测试。
 */
class LoopraModelProviderTest {

    @Test
    void defaultsToChatCompletionsProtocol() {
        LoopraModelProvider provider = provider("openai", "chat_completions", "gpt-4o");
        assertInstanceOf(OpenAiChatCompletionsProvider.class, provider.provider());
    }

    @Test
    void supportsResponsesProtocol() {
        LoopraModelProvider provider = provider("openai", "responses", "gpt-5");
        assertInstanceOf(OpenAiResponsesProvider.class, provider.provider());
    }

    @Test
    void supportsAnthropicProtocol() {
        LoopraModelProvider provider = provider("anthropic", "anthropic", "claude-3-7-sonnet");
        assertInstanceOf(AnthropicMessagesProvider.class, provider.provider());
    }

    @Test
    void supportsOpenCodeCompatibilityAndSendsStableSessionHeader() throws Exception {
        OpenCodeProviderInterceptor interceptor = null;
        AtomicReference<String> sessionHeader = new AtomicReference<>();
        HttpServer server = HttpServer.create(new InetSocketAddress(0), 0);
        server.createContext("/v1/chat/completions", exchange -> {
            sessionHeader.set(exchange.getRequestHeaders().getFirst("x-opencode-session"));
            exchange.getRequestBody().readAllBytes();
            byte[] response = "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"ok\"}}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1}}"
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        server.start();
        try {
            LoopraModelProvider provider = new LoopraModelProvider(
                    "http://127.0.0.1:" + server.getAddress().getPort() + "/v1/chat/completions",
                    "test-key", "gpt-5", "none", "channel", "chat_completions", "opencode", 32768);
            // 先创建底层 Provider，再注册插件，验证请求发送前仍会执行头拦截。
            assertInstanceOf(OpenAiChatCompletionsProvider.class, provider.provider());
            interceptor = new OpenCodeProviderInterceptor();
            provider.call(new ModelCallRequest(
                    "gpt-5", List.of(new Message("user", "hi")), List.of(),
                    Map.of("sessionAffinity", "session-abc")));

            assertEquals("session-abc", sessionHeader.get());
        } finally {
            if (interceptor != null) {
                ProviderInterceptor.unregister(interceptor);
            }
            server.stop(0);
        }
    }

    @Test
    void stripsContextSizeSuffixForProviderAndCapabilities() {
        LoopraModelProvider provider = provider("openai", "chat_completions", "mimo-v2.5[512k]");
        assertEquals("mimo-v2.5[512k]", provider.getModel());
        assertEquals("mimo-v2.5", provider.effectiveModel());
        assertTrue(provider.capabilities().models().contains("mimo-v2.5"));
    }

    @Test
    void forkKeepsProtocolAndModelConfig() {
        LoopraModelProvider provider = provider("openai", "responses", "mimo-v2.5[512k]");
        LoopraModelProvider fork = provider.fork();

        assertEquals("mimo-v2.5[512k]", fork.getModel());
        assertEquals("mimo-v2.5", fork.effectiveModel());
        assertInstanceOf(OpenAiResponsesProvider.class, fork.provider());
    }

    @BeforeEach
    void clearLogSession() {
        LoopraModelProvider.CURRENT_LOG_SESSION.remove();
    }
    
    @AfterEach
    void clearLogSessionAfter() {
        LoopraModelProvider.CURRENT_LOG_SESSION.remove();
    }
    
    @Test
    void preparesReasoningEffortForResponsesRequests() {
        LoopraModelProvider provider = provider("openai", "responses", "gpt-5");
        ModelCallRequest prepared = provider.prepareRequest(new ModelCallRequest(
            "gpt-5",
            List.of(new Message("user", "hi")),
            List.of(),
            Map.of()
        ));

        assertEquals("high", prepared.options().get("reasoningEffort"));
    }

    @Test
    void appliesConfiguredMaxTokensThroughCutinInterceptor() throws Exception {
        AtomicReference<String> requestBody = new AtomicReference<>();
        HttpServer server = HttpServer.create(new InetSocketAddress(0), 0);
        server.createContext("/v1/chat/completions", exchange -> {
            requestBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] response = "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"ok\"}}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1}}"
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        server.start();
        try {
            LoopraModelProvider provider = new LoopraModelProvider(
                    "http://127.0.0.1:" + server.getAddress().getPort() + "/v1/chat/completions",
                    "test-key", "gpt-5", "none", "channel", "chat_completions", "", 32768);
            ModelCallRequest request = new ModelCallRequest(
                    "gpt-5", List.of(new Message("user", "hi")), List.of(), Map.of());

            provider.call(request);
            assertEquals(32768, JsonSupport.intValue(JsonSupport.read(requestBody.get()), 0, "max_tokens"));

            provider.setMaxTokens(65536);
            provider.call(request);
            assertEquals(65536, JsonSupport.intValue(JsonSupport.read(requestBody.get()), 0, "max_tokens"));
        } finally {
            server.stop(0);
        }
    }

    @Test
    void fallsBackToLogSessionForSessionAffinity() {
        LoopraModelProvider provider = provider("openai", "responses", "gpt-5");
        LoopraModelProvider.CURRENT_LOG_SESSION.set("session-abc");
        ModelCallRequest prepared = provider.prepareRequest(new ModelCallRequest(
            "gpt-5",
            List.of(new Message("user", "hi")),
            List.of(),
            Map.of()
        ));

        assertEquals("session-abc", prepared.options().get("sessionAffinity"));
    }

    @Test
    void explicitSessionAffinityWinsOverLogSessionFallback() {
        LoopraModelProvider provider = provider("openai", "responses", "gpt-5");
        LoopraModelProvider.CURRENT_LOG_SESSION.set("log-session");
        provider.setSessionAffinity("explicit-session");
        ModelCallRequest prepared = provider.prepareRequest(new ModelCallRequest(
            "gpt-5",
            List.of(new Message("user", "hi")),
            List.of(),
            Map.of()
        ));

        assertEquals("explicit-session", prepared.options().get("sessionAffinity"));
    }

    @Test
    void skipsSessionAffinityWhenExplicitAndLogSessionBothAbsent() {
        LoopraModelProvider provider = provider("openai", "responses", "gpt-5");
        ModelCallRequest prepared = provider.prepareRequest(new ModelCallRequest(
            "gpt-5",
            List.of(new Message("user", "hi")),
            List.of(),
            Map.of()
        ));

        assertEquals(null, prepared.options().get("sessionAffinity"));
    }

    @Test
    void keepsRequestCarriedSessionAffinityWhenExplicitAndLogSessionAbsent() {
        LoopraModelProvider provider = provider("openai", "responses", "gpt-5");
        ModelCallRequest prepared = provider.prepareRequest(new ModelCallRequest(
            "gpt-5",
            List.of(new Message("user", "hi")),
            List.of(),
            Map.of("sessionAffinity", "session-abc")
        ));

        assertEquals("session-abc", prepared.options().get("sessionAffinity"));
    }

    @Test
    void explicitSessionAffinityOverridesRequestCarriedValue() {
        LoopraModelProvider provider = provider("openai", "responses", "gpt-5");
        provider.setSessionAffinity("sub-agent:nonce");
        ModelCallRequest prepared = provider.prepareRequest(new ModelCallRequest(
            "gpt-5",
            List.of(new Message("user", "hi")),
            List.of(),
            Map.of("sessionAffinity", "parent-session")
        ));

        assertEquals("sub-agent:nonce", prepared.options().get("sessionAffinity"));
    }

    private static LoopraModelProvider provider(String channelId, String protocol, String model) {
        return new LoopraModelProvider(
                "http://localhost/v1",
                "test-key",
                model,
                "high",
                channelId,
                protocol);
    }
}
