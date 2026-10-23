package site.sorghum.loopra.bin.model;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.bin.agent.environment.ChatMode;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertThrows;

class UserMessageSanitizerTest {
    private static final byte[] PNG_HEADER = {
            (byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'
    };

    @TempDir
    Path workspace;

    @AfterEach
    void resetDependencies() {
        UserMessageSanitizer.modalityProvider = null;
    }

    @Test
    void usesChannelFromModelProviderWhenResolvingImageInputCapability() {
        AtomicReference<String> resolvedChannel = new AtomicReference<>();
        UserMessageSanitizer.modalityProvider = new ModelModalityProvider() {
            @Override
            public ModalitySupport _getModalitySupport(String modelName) {
                return ModalitySupport.TEXT_ONLY;
            }

            @Override
            public ModalitySupport getModalitySupport(String channelId, String modelName) {
                resolvedChannel.set(channelId);
                return new ModalitySupport(true, false, false, false, false, false, false, true, true);
            }
        };
        LoopraModelProvider client = new LoopraModelProvider(
                "https://api.example.test/v1/chat/completions", "key", "shared-model", "high", "vision-channel");
        UserMessage message = UserMessage.of("describe", List.of("https://example.test/image.png"));

        assertSame(message, UserMessageSanitizer.sanitize(message, client));
        assertEquals("vision-channel", resolvedChannel.get());
    }

    @Test
    void savesImagesAndLeavesReadImagePathForTextOnlyModel() throws Exception {
        UserMessageSanitizer.modalityProvider = modelName -> ModalitySupport.TEXT_ONLY;
        String dataUri = "data:image/png;base64," + Base64.getEncoder().encodeToString(PNG_HEADER);
        UserMessage message = UserMessage.of("请看看这张图", List.of(dataUri));
        LoopraModelProvider client = new LoopraModelProvider(
                "https://api.example.test/v1/chat/completions", "key", "text-model", "high", "text-channel");

        UserMessage sanitized = UserMessageSanitizer.sanitize(message, client, workspace);

        assertTrue(sanitized.isPlainText());
        assertTrue(sanitized.getText().startsWith("```折叠块\n"));
        assertTrue(sanitized.getText().contains("用户发送了 1 张图片，但当前模型不支持直接查看图片。"));
        assertFalse(sanitized.getText().contains(dataUri));
        assertTrue(sanitized.getText().contains("read_image"));
        assertTrue(sanitized.getText().contains(".loopra/read_img/"));
        assertTrue(sanitized.getText().endsWith("请看看这张图"));
        Path imageDirectory = workspace.resolve(".loopra").resolve("read_img");
        try (var files = Files.list(imageDirectory)) {
            Path saved = files.findFirst().orElseThrow();
            assertArrayEquals(PNG_HEADER, Files.readAllBytes(saved));
        }
    }

    @Test
    void pureChatRejectsUnsupportedImagesWithoutSavingFilesOrSuggestingUnavailableTools() {
        String previousHome = System.getProperty("user.home");
        System.setProperty("user.home", workspace.toString());
        UserMessageSanitizer.modalityProvider = modelName -> ModalitySupport.TEXT_ONLY;
        UserMessage message = UserMessage.of("describe", List.of(
                "data:image/png;base64," + Base64.getEncoder().encodeToString(PNG_HEADER)));
        try {
            IllegalArgumentException error = assertThrows(IllegalArgumentException.class, () ->
                    UserMessageSanitizer.sanitize(message, "text-model", "channel", ChatMode.root()));
            assertTrue(error.getMessage().contains("切换到支持图片的模型"));
            assertFalse(Files.exists(ChatMode.root()));
            assertEquals(1, message.getImages().size());
            UserMessageSanitizer.modalityProvider = modelName ->
                    new ModalitySupport(true, false, false, false, false, false, false, true, true);
            assertSame(message, UserMessageSanitizer.sanitize(message, "vision-model", "channel", ChatMode.root()));
            assertFalse(Files.exists(ChatMode.root()));
        } finally {
            System.setProperty("user.home", previousHome);
        }
    }

    @Test
    void mergesImageContextIntoExistingCollapsedBlock() throws Exception {
        UserMessageSanitizer.modalityProvider = modelName -> ModalitySupport.TEXT_ONLY;
        String dataUri = "data:image/png;base64," + Base64.getEncoder().encodeToString(PNG_HEADER);
        UserMessage message = UserMessage.of(
                "```折叠块\n调用技能：\n/skill:find-skills\n```\n\n请看看这张图",
                List.of(dataUri));
        LoopraModelProvider client = new LoopraModelProvider(
                "https://api.example.test/v1/chat/completions", "key", "text-model", "high", "text-channel");

        UserMessage sanitized = UserMessageSanitizer.sanitize(message, client, workspace);
        String text = sanitized.getText();

        assertEquals(text.indexOf("```折叠块"), text.lastIndexOf("```折叠块"));
        assertTrue(text.contains("调用技能：\n/skill:find-skills"));
        assertTrue(text.contains("用户发送了 1 张图片，但当前模型不支持直接查看图片。"));
        assertTrue(text.endsWith("请看看这张图"));
    }
}
