package site.sorghum.loopra.integration.cutin;

import org.junit.jupiter.api.Test;
import site.sorghum.cutin.core.context.Message;
import site.sorghum.loopra.bin.agent.model.ChatMessage;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 回归测试：多模态 ChatMessage（contentParts 模式）经桥接转换后，
 * 文本与图片都不能丢失 —— 否则 compaction 在每次模型调用前整体覆盖
 * cutin 上下文时，会把"文字+图片"的用户消息清成空输入（上游 400）。
 */
class CutinMessageBridgeTest {

    @Test
    void multimodalUserMessageKeepsTextAndImages() {
        ChatMessage chat = ChatMessage.ofUser("看看这张图", List.of("https://example.com/a.png"));

        Message cutin = CutinMessageBridge.toCutin(chat);

        assertEquals("user", cutin.role());
        assertEquals("看看这张图", cutin.content());
        assertEquals(List.of("https://example.com/a.png"), cutin.metadata("images"));
    }

    @Test
    void imageOnlyUserMessageKeepsImagesWithNullText() {
        ChatMessage chat = ChatMessage.ofUser("", List.of("https://example.com/a.png"));

        Message cutin = CutinMessageBridge.toCutin(chat);

        assertEquals("user", cutin.role());
        assertNull(cutin.content());
        assertEquals(List.of("https://example.com/a.png"), cutin.metadata("images"));
    }

    @Test
    void plainUserMessageStaysUnchanged() {
        ChatMessage chat = ChatMessage.ofUser("你好");

        Message cutin = CutinMessageBridge.toCutin(chat);

        assertEquals("user", cutin.role());
        assertEquals("你好", cutin.content());
        assertFalse(cutin.metadata().containsKey("images"));
    }

    @Test
    void toolMessagePreservesToolImageUrlMetadata() {
        ChatMessage chat = ChatMessage.tool("call_1", "截图内容");
        chat.setToolImageUrl("data:image/png;base64,AAAA");

        Message cutin = CutinMessageBridge.toCutin(chat);

        assertEquals("tool", cutin.role());
        assertEquals("call_1", cutin.toolCallId());
        assertEquals("截图内容", cutin.content());
        assertEquals("data:image/png;base64,AAAA", cutin.metadata("tool_image_url"));
    }

    @Test
    void toolImageSurvivesRoundTripAndKeepsDetail() {
        ChatMessage original = ChatMessage.toolWithImage(
                "call_1", "image loaded", "data:image/png;base64,AAAA", "high");
        Message cutin = CutinMessageBridge.toCutin(original);
        assertEquals("high", cutin.metadata("tool_image_detail"));
        ChatMessage restored = CutinMessageBridge.toLoopra(List.of(cutin)).get(0);
        assertEquals(original.getToolCallId(), restored.getToolCallId());
        assertEquals(original.getContent(), restored.getContent());
        assertEquals(original.getToolImageUrl(), restored.getToolImageUrl());
        assertEquals(original.getToolImageDetail(), restored.getToolImageDetail());
    }

    @Test
    void assistantMessagePreservesToolImageUrlMetadata() {
        ChatMessage chat = ChatMessage.assistant("我看了截图", null, null);
        chat.setToolImageUrl("data:image/png;base64,BBBB");

        Message cutin = CutinMessageBridge.toCutin(chat);

        assertEquals("assistant", cutin.role());
        assertEquals("我看了截图", cutin.content());
        assertEquals("data:image/png;base64,BBBB", cutin.metadata("tool_image_url"));
    }

    @Test
    void multimodalMessageSurvivesWholeHistoryConversion() {
        ChatMessage chat = ChatMessage.ofUser("描述图片", List.of("https://example.com/a.png", "https://example.com/b.png"));

        List<Message> cutin = CutinMessageBridge.toCutin(List.of(chat));

        assertEquals(1, cutin.size());
        assertEquals("描述图片", cutin.get(0).content());
        assertTrue(cutin.get(0).metadata("images") instanceof List<?> images
                && images.size() == 2);
    }
}
