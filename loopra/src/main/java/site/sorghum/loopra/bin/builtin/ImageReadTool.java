package site.sorghum.loopra.bin.builtin;

import org.noear.solon.ai.annotation.ToolMapping;
import org.noear.solon.ai.chat.tool.AbsToolProvider;
import org.noear.solon.ai.chat.tool.FunctionTool;
import org.noear.solon.annotation.Component;
import org.noear.solon.annotation.Inject;
import org.noear.solon.annotation.Param;
import site.sorghum.loopra.bin.agent.model.ImageToolResult;
import site.sorghum.loopra.bin.agent.spi.AgentConfig;
import site.sorghum.loopra.bin.model.LoopraModelProvider;
import site.sorghum.loopra.bin.model.ModalitySupport;
import site.sorghum.loopra.bin.model.ModelModalityProvider;
import site.sorghum.loopra.tool.AgentLoopController;
import site.sorghum.loopra.tool.SolonToTools;
import site.sorghum.loopra.tool.ToolContext;

import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URLConnection;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.Collection;
import java.util.Locale;
import java.util.Map;

import static site.sorghum.loopra.bin.util.ImageBytes.detectMimeType;
import static site.sorghum.loopra.bin.util.ImageBytes.readLimited;

/** 读取本地、base64 编码或远程图片；必要时交给独立图片理解模型转换为文字。 */
@Component
public class ImageReadTool extends AbsToolProvider implements SolonToTools {
    private static final long MAX_IMAGE_BYTES = 5L * 1024 * 1024;

    /** 模型多模态支持提供者（Solon 注入，无容器环境为 null 时不做能力拦截）。 */
    @Inject
    public static ModelModalityProvider modalityProvider;

    /** 当前模型不支持图片时使用的图片理解服务。 */
    @Inject
    public static ImageUnderstandingService understandingService;

    private static final Map<String, String> MIME_TYPES = Map.of(
            "png", "image/png",
            "jpg", "image/jpeg",
            "jpeg", "image/jpeg",
            "gif", "image/gif",
            "webp", "image/webp"
    );

    @ToolMapping(name = "read_image", description = """
            读取 PNG、JPEG、GIF 或 WebP 图片并分析其内容。
            当前模型支持图片输入时，图片会作为视觉上下文传给当前模型；当前模型不支持时，自动使用已配置的图片理解模型生成文字结果。
            每次必须提供且仅提供一个来源：file_path（项目相对路径或绝对路径）、base64（原始 Base64 或 data URI）、url（HTTP/HTTPS 图片地址）。
            detail 可选，取值 auto、low 或 high；prompt 可选，用于描述本次希望重点识别的内容，例如“提取图片中的报错文字”。
            图片最大 5 MiB。此工具只读，不支持 SVG 或其他非图片文件。
            """)
    public String readImage(
            @Param(name = "file_path", description = "图片路径。相对路径相对于项目，绝对路径可直接使用", required = false) String filePath,
            @Param(name = "base64", description = "图片的原始 Base64 字符串或 data:image/...;base64,...", required = false) String base64,
            @Param(name = "url", description = "HTTP 或 HTTPS 图片地址", required = false) String url,
            @Param(name = "detail", description = "图片分析精度：auto、low 或 high，默认 auto", required = false, defaultValue = "auto") String detail,
            @Param(name = "prompt", description = "本次图片识别的任务描述，例如提取文字、识别报错或读取表格", required = false) String prompt,
            @Param(name = "ctx", required = false) ToolContext ctx) {
        String normalizedDetail = normalizeDetail(detail);
        if (normalizedDetail == null) {
            return "PARAM_INVALID: detail must be one of auto, low, or high";
        }
        String normalizedPrompt = normalizePrompt(prompt);
        int sourceCount = countPresent(filePath, base64, url);
        if (sourceCount == 0) {
            return "PARAM_MISSING: provide exactly one of file_path, base64, or url";
        }
        if (sourceCount > 1) {
            return "PARAM_INVALID: provide only one of file_path, base64, or url";
        }

        try {
            ImageData image = !isBlank(filePath) ? readPath(filePath, ctx)
                    : !isBlank(base64) ? decodeBase64(base64) : downloadUrl(url);
            if (image.bytes().length > MAX_IMAGE_BYTES) {
                return "IMAGE_TOO_LARGE: 图片大小为 " + image.bytes().length + " 字节，最大允许 " + MAX_IMAGE_BYTES + " 字节";
            }
            String dataUri = "data:" + image.mimeType() + ";base64,"
                    + Base64.getEncoder().encodeToString(image.bytes());

            // 模型不支持图片输入时，使用独立的图片理解模型生成文字结果；
            // 只有在当前模型支持图片时，才把原图作为视觉上下文回放给主模型。
            String blocked = modelImageSupportBlocked(ctx);
            if (blocked != null) {
                AgentConfig config = currentAgentConfig(ctx);
                if (config == null) {
                    return "MODEL_NOT_SUPPORTED: " + blocked + "，且无法获取图片理解模型配置";
                }
                // Solon 会注入单例；直接 Java 调用或轻量测试环境没有容器时，
                // 该服务本身无状态，可以安全地按需创建，仍保持同一回退行为。
                ImageUnderstandingService service = understandingService != null
                        ? understandingService : new ImageUnderstandingService();
                return service.understand(config, dataUri, normalizedDetail, normalizedPrompt);
            }

            String summary = "已读取图片 " + image.source() + "（" + image.mimeType() + "，" + image.bytes().length
                    + " 字节），图片已作为视觉上下文传给 AI。"
                    + (normalizedPrompt.isEmpty() ? "" : " 本次识别要求：" + normalizedPrompt);
            return imageResult(summary, dataUri, normalizedDetail);
        } catch (SecurityException e) {
            return "PATH_DENIED: 项目相对路径必须位于当前项目内";
        } catch (IllegalArgumentException e) {
            return "PARAM_INVALID: " + e.getMessage();
        } catch (IOException e) {
            return "IMAGE_READ_FAILED: " + e.getMessage();
        } catch (Exception e) {
            return "IMAGE_READ_FAILED: 无法读取图片";
        }
    }

    /** 为已有直接 Java 调用方保留原始五参数 API。 */
    public String readImage(String filePath, String base64, String url, String detail, ToolContext ctx) {
        return readImage(filePath, base64, url, detail, null, ctx);
    }

    /** 为只读取工作区图片的调用方保留旧的直接 Java API。 */
    public String readImage(String filePath, String detail, ToolContext ctx) {
        return readImage(filePath, null, null, detail, null, ctx);
    }

    /** 为直接 Java 调用方提供带图片识别要求的 API。 */
    public String readImage(String filePath, String detail, String prompt, ToolContext ctx) {
        return readImage(filePath, null, null, detail, prompt, ctx);
    }

    /**
     * 判断当前模型是否支持图片输入（read_image / browser_screenshot 等视觉工具共用）。
     * 支持或无法判断（无控制器/无客户端/无提供者）时返回 {@code true}；仅明确不支持时返回 {@code false}。
     */
    static boolean supportsImageInput(ToolContext ctx) {
        return modelImageSupportBlocked(ctx) == null;
    }

    /**
     * 检查当前模型是否支持图片输入。
     * 不支持时返回错误描述；支持或无法判断（无控制器/无客户端/无提供者）时返回 {@code null}。
     */
    private static String modelImageSupportBlocked(ToolContext ctx) {
        if (ctx == null) return null;
        AgentLoopController controller = ctx.getLoopController();
        if (controller == null) return null;
        LoopraModelProvider client = controller.getModelProvider();
        if (client == null) return null;
        ModelModalityProvider provider = modalityProvider;
        if (provider == null) return null;
        ModalitySupport support = provider.getModalitySupport(client.getModelChannelId(), client.getModel());
        if (support != null && !support.imageInput()) {
            return "当前模型（" + client.getModel() + "）不支持图片输入";
        }
        return null;
    }

    private static AgentConfig currentAgentConfig(ToolContext ctx) {
        if (ctx == null || ctx.getLoopController() == null) return null;
        return ctx.getLoopController().getAgentConfig();
    }

    /** 委托内核的图片结果协议（{@link ImageToolResult}），保持对外 API 不变。 */
    public static String imageResult(String summary, String dataUri, String detail) {
        return ImageToolResult.imageResult(summary, dataUri, detail);
    }

    public static ImageToolResult.ImageResult parseResult(String result) {
        return ImageToolResult.parseResult(result);
    }

    private static ImageData readPath(String filePath, ToolContext ctx) throws IOException {
        Path requested = Path.of(filePath);
        Path image;
        String source;
        if (requested.isAbsolute()) {
            image = requested.toRealPath();
            source = image.toString();
        } else {
            if (ctx == null || ctx.getRootDir() == null) {
                throw new IOException("当前工具没有可用的项目上下文");
            }
            Path root = ctx.getRootDir().toRealPath();
            Path candidate = root.resolve(requested).normalize();
            if (!candidate.startsWith(root)) {
                throw new SecurityException("outside workspace");
            }
            image = candidate.toRealPath();
            if (!image.startsWith(root)) {
                throw new SecurityException("symlink outside workspace");
            }
            source = root.relativize(image).toString().replace('\\', '/');
        }
        if (!Files.isRegularFile(image)) {
            throw new IOException("图片文件不存在或不是常规文件: " + filePath);
        }
        String mimeType = mimeForExtension(extension(image));
        if (mimeType == null) {
            throw new IllegalArgumentException("仅支持 PNG、JPEG、GIF 或 WebP 图片");
        }
        long size = Files.size(image);
        if (size > MAX_IMAGE_BYTES) {
            throw new IOException("图片大小为 " + size + " 字节，最大允许 " + MAX_IMAGE_BYTES + " 字节");
        }
        return new ImageData(Files.readAllBytes(image), mimeType, source);
    }

    private static ImageData decodeBase64(String value) {
        String compact = value.replaceAll("\\s", "");
        String declaredMime = null;
        if (compact.startsWith("data:")) {
            int comma = compact.indexOf(',');
            if (comma < 0 || !compact.substring(0, comma).endsWith(";base64")) {
                throw new IllegalArgumentException("base64 data URI must use ;base64");
            }
            declaredMime = compact.substring("data:".length(), compact.indexOf(';'));
            compact = compact.substring(comma + 1);
        }
        byte[] bytes;
        try {
            bytes = Base64.getDecoder().decode(compact);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("base64 is invalid");
        }
        if (bytes.length > MAX_IMAGE_BYTES) {
            throw new IllegalArgumentException("图片大小超过 5 MiB 限制");
        }
        String mimeType = declaredMime == null ? detectMimeType(bytes) : normalizeMimeType(declaredMime);
        if (mimeType == null || !MIME_TYPES.containsValue(mimeType)) {
            throw new IllegalArgumentException("base64 不是受支持的 PNG、JPEG、GIF 或 WebP 图片");
        }
        return new ImageData(bytes, mimeType, "Base64 数据");
    }

    private static ImageData downloadUrl(String value) throws IOException {
        URI uri;
        try {
            uri = URI.create(value);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("url is invalid");
        }
        if (!"http".equalsIgnoreCase(uri.getScheme()) && !"https".equalsIgnoreCase(uri.getScheme())) {
            throw new IllegalArgumentException("url must use HTTP or HTTPS");
        }
        URLConnection connection = uri.toURL().openConnection();
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(20_000);
        if (connection instanceof HttpURLConnection http) {
            http.setInstanceFollowRedirects(true);
            int status = http.getResponseCode();
            if (status < 200 || status >= 300) {
                throw new IOException("图片 URL 返回 HTTP " + status);
            }
        }
        long contentLength = connection.getContentLengthLong();
        if (contentLength > MAX_IMAGE_BYTES) {
            throw new IOException("图片大小为 " + contentLength + " 字节，最大允许 " + MAX_IMAGE_BYTES + " 字节");
        }
        byte[] bytes;
        try (InputStream input = connection.getInputStream()) {
            bytes = readLimited(input);
        }
        String mimeType = normalizeMimeType(connection.getContentType());
        if (mimeType == null) mimeType = mimeForExtension(extension(uri.getPath()));
        if (mimeType == null) mimeType = detectMimeType(bytes);
        if (mimeType == null || !MIME_TYPES.containsValue(mimeType)) {
            throw new IOException("URL 不是受支持的 PNG、JPEG、GIF 或 WebP 图片");
        }
        return new ImageData(bytes, mimeType, uri.toString());
    }

    private static int countPresent(String... values) {
        int count = 0;
        for (String value : values) {
            if (!isBlank(value)) count++;
        }
        return count;
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    private static String extension(Path path) {
        return extension(path.getFileName().toString());
    }

    private static String extension(String value) {
        int query = value.indexOf('?');
        String name = query < 0 ? value : value.substring(0, query);
        int dot = name.lastIndexOf('.');
        return dot < 0 ? "" : name.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    private static String mimeForExtension(String extension) {
        return MIME_TYPES.get(extension);
    }

    private static String normalizeMimeType(String value) {
        if (value == null) return null;
        String mimeType = value.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        return MIME_TYPES.containsValue(mimeType) ? mimeType : null;
    }

    private static String normalizeDetail(String detail) {
        return ImageToolResult.normalizeDetail(detail);
    }

    private static String normalizePrompt(String prompt) {
        return prompt == null ? "" : prompt.trim();
    }

    private record ImageData(byte[] bytes, String mimeType, String source) {
    }

    @Override
    public Collection<FunctionTool> getSolonTools() {
        return this.getTools();
    }
}
