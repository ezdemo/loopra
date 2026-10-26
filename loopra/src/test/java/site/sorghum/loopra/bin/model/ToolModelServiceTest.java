package site.sorghum.loopra.bin.model;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.noear.snack4.ONode;
import site.sorghum.loopra.bin.agent.context.ContextFolding;
import site.sorghum.loopra.bin.agent.memory.ProjectMemoryStore;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.config.ConfigService;
import site.sorghum.loopra.bin.config.LoopraConfig;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

class ToolModelServiceTest {
    private static LoopraConfig config(String json) throws Exception {
        var constructor = LoopraConfig.class.getDeclaredConstructor(ONode.class);
        constructor.setAccessible(true);
        return constructor.newInstance(ONode.ofJson(json));
    }

    @Test
    void missingOrRemovedToolModelKeepsExistingBehavior() throws Exception {
        assertNull(ToolModelService.configuredProvider(null));
        assertNull(ToolModelService.configuredProvider(config("{}")));
        assertNull(ToolModelService.configuredProvider(config("{\"toolModel\":\"removed\",\"toolModelChannelId\":\"missing\"}")));
        assertNull(ToolModelService.generateTitle(config("{}"), "hello"));
    }

    @Test
    void titlesUseToolModelWhileCompactionKeepsConversationModel(@TempDir Path workspace) throws Exception {
        var requests = new ArrayList<ONode>();
        var reply = new AtomicReference<>("“整理模型设置”");
        var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/v1/chat/completions", exchange -> {
            requests.add(ONode.ofJson(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8)));
            byte[] body = ONode.serialize(Map.of("choices", List.of(Map.of("message",
                    Map.of("role", "assistant", "content", reply.get()))))).getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            try (var output = exchange.getResponseBody()) { output.write(body); }
        });
        server.start();
        var field = ConfigService.class.getDeclaredField("config");
        field.setAccessible(true);
        Object previous = field.get(null);
        try {
            var config = config("""
                    {"toolModel":"utility/raw-model","toolModelChannelId":"helper",
                     "modelChannels":[{"id":"helper","baseUrl":"http://127.0.0.1:%d/v1",
                       "apiKey":"test-key","apiProtocol":"chat_completions",
                       "models":[{"name":"utility/raw-model","maxTokens":2048}]}]}
                    """.formatted(server.getAddress().getPort()));
            assertEquals("整理模型设置", ToolModelService.generateTitle(config, "调整模型配置"));
            assertEquals("utility/raw-model", requests.get(0).get("model").getString());
            assertEquals(512, requests.get(0).get("max_tokens").getInt());

            field.set(null, config);
            var summaryRequest = new AtomicReference<String>();
            var conversationProvider = TestLoopraProvider.builder().model("conversation-model")
                    .call(request -> {
                        summaryRequest.set(request.modelId());
                        return TestLoopraProvider.response(
                                "<摘要>完成配置拆分</摘要>\n<<<MEMORY>>>\n<记忆>- 模型用途配置独立保存</记忆>");
                    }).build();
            var history = new ArrayList<ChatMessage>();
            history.add(ChatMessage.ofSystem("test"));
            for (int i = 0; i < 30; i++) {
                history.add(ChatMessage.ofUser("需要保留的任务上下文 " + i));
                history.add(ChatMessage.assistant("已完成任务步骤 " + i, null, null));
            }
            var folded = ContextFolding.foldKeepLast(history, 2, conversationProvider, workspace);
            assertTrue(folded.size() < history.size());
            assertTrue(ProjectMemoryStore.load(workspace).contains("模型用途配置独立保存"));
            assertEquals("conversation-model", summaryRequest.get());
            assertEquals(1, requests.size(), "上下文压缩不应额外调用工具模型");
            assertEquals("conversation-model", conversationProvider.getModel());

            reply.set("");
            assertNull(ToolModelService.generateTitle(config, "空回复时使用消息摘要"));
        } finally {
            field.set(null, previous);
            server.stop(0);
        }
    }
}
