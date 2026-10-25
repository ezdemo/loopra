package site.sorghum.cutin.integrations.model;

import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;
import site.sorghum.cutin.core.context.Message;
import site.sorghum.cutin.core.json.JsonSupport;
import site.sorghum.cutin.core.model.ModelCallRequest;
import site.sorghum.cutin.core.tool.ToolCall;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class ToolImageReplayTest {
    private static final String IMAGE = "data:image/png;base64,aGVsbG8=";
    private static final String SECOND_IMAGE = "https://example.com/second.png";
    private static final ModelProviderConfig CONFIG = new ModelProviderConfig(
            "test", "http://localhost", "test-key", "vision-model", Map.of());

    private static ModelCallRequest request() {
        return new ModelCallRequest("vision-model", List.of(
                new Message("assistant", null, null, List.of(
                        new ToolCall("image-1", "read_image", Map.of(), "image-1"),
                        new ToolCall("text-1", "read", Map.of(), "text-1"),
                        new ToolCall("image-2", "read_image", Map.of(), "image-2"))),
                new Message("tool", "image loaded", "image-1", List.of(),
                        Map.of("tool_image_url", IMAGE, "tool_image_detail", "high")),
                new Message("tool", "plain result", "text-1", List.of()),
                new Message("tool", "second image loaded", "image-2", List.of(),
                        Map.of("tool_image_url", SECOND_IMAGE)),
                new Message("assistant", "done")), List.of(), Map.of());
    }

    @Test
    void chatCompletionsIncludesImagesAfterAllParallelToolResults() {
        var provider = new OpenAiChatCompletionsProvider(CONFIG);
        var request = request();
        for (boolean stream : new boolean[]{false, true}) {
            ONode body = provider.buildBody(request, stream);
            assertEquals(7, JsonSupport.child(body, "messages").getArray().size());
            assertEquals("image-1", JsonSupport.text(body, "", "messages", 1, "tool_call_id"));
            assertEquals("text-1", JsonSupport.text(body, "", "messages", 2, "tool_call_id"));
            assertEquals("image-2", JsonSupport.text(body, "", "messages", 3, "tool_call_id"));
            assertEquals("plain result", JsonSupport.text(body, "", "messages", 2, "content"));
            assertEquals("user", JsonSupport.text(body, "", "messages", 4, "role"));
            assertTrue(JsonSupport.text(body, "", "messages", 4, "content", 0, "text").contains("image-1"));
            assertEquals("image_url", JsonSupport.text(body, "", "messages", 4, "content", 1, "type"));
            assertEquals(IMAGE, JsonSupport.text(body, "", "messages", 4, "content", 1, "image_url", "url"));
            assertEquals("high", JsonSupport.text(body, "", "messages", 4, "content", 1, "image_url", "detail"));
            assertEquals(SECOND_IMAGE, JsonSupport.text(body, "", "messages", 5, "content", 1, "image_url", "url"));
            assertEquals("done", JsonSupport.text(body, "", "messages", 6, "content"));
            // Request conversion must not append synthetic messages to stored history.
            assertEquals(5, request.messages().size());
        }
    }

    @Test
    void responsesIncludesImagesAfterAllFunctionCallOutputs() {
        var provider = new OpenAiResponsesProvider(CONFIG);
        for (boolean stream : new boolean[]{false, true}) {
            ONode body = provider.buildBody(request(), stream);
            assertEquals(9, JsonSupport.child(body, "input").getArray().size());
            assertEquals("function_call_output", JsonSupport.text(body, "", "input", 3, "type"));
            assertEquals("image-1", JsonSupport.text(body, "", "input", 3, "call_id"));
            assertEquals("text-1", JsonSupport.text(body, "", "input", 4, "call_id"));
            assertEquals("image-2", JsonSupport.text(body, "", "input", 5, "call_id"));
            assertEquals("user", JsonSupport.text(body, "", "input", 6, "role"));
            assertEquals("input_image", JsonSupport.text(body, "", "input", 6, "content", 1, "type"));
            assertEquals(IMAGE, JsonSupport.text(body, "", "input", 6, "content", 1, "image_url"));
            assertEquals("high", JsonSupport.text(body, "", "input", 6, "content", 1, "detail"));
            assertEquals(SECOND_IMAGE, JsonSupport.text(body, "", "input", 7, "content", 1, "image_url"));
            assertEquals("done", JsonSupport.text(body, "", "input", 8, "content"));
        }
    }

    @Test
    void anthropicIncludesImagesAndKeepsToolResultsBeforeOtherUserContent() {
        var provider = new AnthropicMessagesProvider(CONFIG);
        for (boolean stream : new boolean[]{false, true}) {
            ONode body = provider.buildBody(request(), stream);
            assertEquals(3, JsonSupport.child(body, "messages").getArray().size());
            assertEquals("user", JsonSupport.text(body, "", "messages", 1, "role"));
            for (int i = 0; i < 3; i++) {
                assertEquals("tool_result", JsonSupport.text(body, "", "messages", 1, "content", i, "type"));
            }
            assertEquals("image", JsonSupport.text(body, "", "messages", 1, "content", 4, "type"));
            assertEquals("image/png", JsonSupport.text(body, "", "messages", 1, "content", 4, "source", "media_type"));
            assertEquals("aGVsbG8=", JsonSupport.text(body, "", "messages", 1, "content", 4, "source", "data"));
            assertEquals(SECOND_IMAGE, JsonSupport.text(body, "", "messages", 1, "content", 6, "source", "url"));
        }
    }

    @Test
    void textOnlyToolResultsDoNotCreateImageMessages() {
        var request = new ModelCallRequest("model", List.of(
                new Message("tool", "plain result", "text-1", List.of())), List.of(), Map.of());
        ONode body = new OpenAiChatCompletionsProvider(CONFIG).buildBody(request, false);
        assertEquals(1, JsonSupport.child(body, "messages").getArray().size());
        assertEquals("plain result", JsonSupport.text(body, "", "messages", 0, "content"));
    }
}
