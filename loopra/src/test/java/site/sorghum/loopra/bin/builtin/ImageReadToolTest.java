package site.sorghum.loopra.bin.builtin;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import com.sun.net.httpserver.HttpServer;
import site.sorghum.loopra.bin.agent.model.ImageToolResult;
import site.sorghum.loopra.bin.agent.spi.AgentConfig;
import site.sorghum.loopra.bin.config.LoopraConfig;
import site.sorghum.loopra.bin.model.LoopraModelProvider;
import site.sorghum.loopra.bin.model.ModalitySupport;
import site.sorghum.loopra.bin.model.ModelModalityProvider;
import site.sorghum.loopra.bin.tool.ToolRegistry;
import site.sorghum.loopra.tool.AgentLoopController;
import site.sorghum.loopra.tool.AgentOutput;
import site.sorghum.loopra.tool.ToolContext;

import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

class ImageReadToolTest {
    private static final byte[] PNG_HEADER = {
            (byte) 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'
    };

    @TempDir
    Path workspace;

    @AfterEach
    void resetDependencies() {
        ImageReadTool.modalityProvider = null;
        ImageReadTool.understandingService = null;
        ToolContext.clearCurrentController();
    }

    @Test
    void readsWorkspaceImageAsVisualContext() throws Exception {
        Files.write(workspace.resolve("diagram.png"), PNG_HEADER);
        ImageReadTool tool = new ImageReadTool();

        String result = tool.readImage("diagram.png", "high",
                new ToolContext(Map.of(), workspace.toString(), "session-1"));
        ImageToolResult.ImageResult image = ImageReadTool.parseResult(result);

        assertNotNull(image);
        assertEquals("high", image.detail());
        assertTrue(image.summary().contains("diagram.png"));
        assertTrue(image.dataUri().startsWith("data:image/png;base64,"));
    }

    @Test
    void readsAbsoluteImagePath() throws Exception {
        Path imagePath = workspace.getParent().resolve("absolute.png");
        Files.write(imagePath, PNG_HEADER);
        ImageReadTool tool = new ImageReadTool();

        String result = tool.readImage(imagePath.toString(), "auto",
                new ToolContext(Map.of(), workspace.toString(), "session-1"));

        assertNotNull(ImageReadTool.parseResult(result));
    }

    @Test
    void decodesBase64DataUri() {
        ImageReadTool tool = new ImageReadTool();
        String dataUri = "data:image/png;base64," + Base64.getEncoder().encodeToString(PNG_HEADER);

        String result = tool.readImage(null, dataUri, null, "low", null);
        ImageToolResult.ImageResult image = ImageReadTool.parseResult(result);

        assertNotNull(image);
        assertEquals("low", image.detail());
        assertTrue(image.dataUri().startsWith("data:image/png;base64,"));
    }

    @Test
    void createsVisualResultForBrowserSnapshot() {
        String result = ImageReadTool.imageResult("{\"snapshotId\":\"tab-1-s1\"}",
                "data:image/png;base64," + Base64.getEncoder().encodeToString(PNG_HEADER), "auto");
        ImageToolResult.ImageResult image = ImageReadTool.parseResult(result);

        assertNotNull(image);
        assertEquals("auto", image.detail());
        assertEquals("{\"snapshotId\":\"tab-1-s1\"}", image.summary());
    }

    @Test
    void rejectsPathsOutsideWorkspace() throws Exception {
        Path outside = workspace.getParent().resolve("outside.png");
        Files.write(outside, PNG_HEADER);
        ImageReadTool tool = new ImageReadTool();

        String result = tool.readImage("../outside.png", "auto",
                new ToolContext(Map.of(), workspace.toString(), "session-1"));

        assertEquals("PATH_DENIED: 项目相对路径必须位于当前项目内", result);
    }

    @Test
    void blocksImageReadWhenModelLacksImageInput() throws Exception {
        Files.write(workspace.resolve("diagram.png"), PNG_HEADER);
        ImageReadTool tool = new ImageReadTool();
        ImageReadTool.modalityProvider = new ModelModalityProvider() {
            @Override
            public ModalitySupport _getModalitySupport(String modelName) {
                return ModalitySupport.TEXT_ONLY;
            }
        };
        ToolContext.setCurrentController(controllerWith(new LoopraModelProvider(
                "https://api.example.test/v1/chat/completions", "key", "text-model", "high", "text-channel")));

        String result = tool.readImage("diagram.png", "high",
                new ToolContext(Map.of(), workspace.toString(), "session-1"));

        assertTrue(result.startsWith("MODEL_NOT_SUPPORTED: "), result);
        assertTrue(result.contains("text-model"), result);
    }

    @Test
    void allowsImageReadWhenModelSupportsImageInput() throws Exception {
        Files.write(workspace.resolve("diagram.png"), PNG_HEADER);
        ImageReadTool tool = new ImageReadTool();
        ImageReadTool.modalityProvider = new ModelModalityProvider() {
            @Override
            public ModalitySupport _getModalitySupport(String modelName) {
                return new ModalitySupport(true, false, false, false, false, false, false, true, true);
            }
        };
        ToolContext.setCurrentController(controllerWith(new LoopraModelProvider(
                "https://api.example.test/v1/chat/completions", "key", "vision-model", "high", "vision-channel")));

        String result = tool.readImage("diagram.png", "high",
                new ToolContext(Map.of(), workspace.toString(), "session-1"));

        assertNotNull(ImageReadTool.parseResult(result));
    }

    @Test
    void delegatesToConfiguredImageUnderstandingModelWhenCurrentModelLacksImageInput() throws Exception {
        Files.write(workspace.resolve("diagram.png"), PNG_HEADER);
        AtomicReference<String> requestBody = new AtomicReference<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("localhost", 0), 0);
        server.createContext("/v1/chat/completions", exchange -> {
            requestBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] response = "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"图片中有一个图表\"}}]}"
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, response.length);
            try (OutputStream output = exchange.getResponseBody()) {
                output.write(response);
            }
        });
        server.start();
        try {
            ImageReadTool.modalityProvider = new ModelModalityProvider() {
                @Override
                public ModalitySupport _getModalitySupport(String modelName) {
                    return ModalitySupport.TEXT_ONLY;
                }
            };
            String baseUrl = "http://localhost:" + server.getAddress().getPort() + "/v1";
            AgentConfig.Channel imageChannel = new LoopraConfig.ModelChannel(
                    "vision", "Vision", baseUrl, "vision-key", "chat_completions",
                    List.of(new LoopraConfig.ModelEntry("vision-model", -1, true, Map.of())));
            ToolContext.setCurrentController(controllerWith(
                    new LoopraModelProvider(
                            "https://api.example.test/v1/chat/completions", "key", "text-model", "high", "text-channel"),
                    imageUnderstandingConfig(imageChannel)));

            String result = new ImageReadTool().readImage("diagram.png", "high", "extract chart title and values",
                    new ToolContext(Map.of(), workspace.toString(), "session-1"));

            assertEquals("图片已由图片理解模型分析：\n图片中有一个图表", result);
            assertTrue(requestBody.get().contains("\"model\":\"vision-model\""), requestBody.get());
            assertTrue(requestBody.get().contains("data:image/png;base64,"), requestBody.get());
            assertTrue(requestBody.get().contains("extract chart title and values"), requestBody.get());
        } finally {
            server.stop(0);
        }
    }

    private static AgentLoopController controllerWith(LoopraModelProvider modelProvider) {
        return controllerWith(modelProvider, null);
    }

    private static AgentLoopController controllerWith(LoopraModelProvider modelProvider, AgentConfig config) {
        return new AgentLoopController() {
            @Override
            public AgentOutput getOutput() {
                return null;
            }

            @Override
            public void requestStop() {
            }

            @Override
            public void injectUserMessage(String message) {
            }

            @Override
            public ToolRegistry getToolRegistry() {
                return null;
            }

            @Override
            public LoopraModelProvider getModelProvider() {
                return modelProvider;
            }

            @Override
            public AgentConfig getAgentConfig() {
                return config;
            }
        };
    }

    private static AgentConfig imageUnderstandingConfig(AgentConfig.Channel imageChannel) {
        return new AgentConfig() {
            @Override public int maxContextChars() { return 200_000; }
            @Override public int keepTailChars() { return 80_000; }
            @Override public int toolTimeoutSec() { return 60; }
            @Override public int subAgentTimeoutSec() { return 600; }
            @Override public int maxSelfCorrectionAttempts() { return 1; }
            @Override public int stormWindowSize() { return 8; }
            @Override public int stormThreshold() { return 4; }
            @Override public String validationModel() { return ""; }
            @Override public Channel validationModelChannel() { return null; }
            @Override public List<String> autoWhitelist() { return List.of(); }
            @Override public String imageUnderstandingModel() { return "vision-model"; }
            @Override public Channel imageUnderstandingModelChannel() { return imageChannel; }
        };
    }
}
