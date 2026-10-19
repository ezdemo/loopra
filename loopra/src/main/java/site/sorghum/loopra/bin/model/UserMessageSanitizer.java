package site.sorghum.loopra.bin.model;

import lombok.extern.slf4j.Slf4j;
import org.noear.solon.annotation.Component;
import org.noear.solon.annotation.Inject;
import site.sorghum.loopra.bin.agent.model.UserMessage;

import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URLConnection;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static site.sorghum.loopra.bin.util.ImageBytes.detectMimeType;
import static site.sorghum.loopra.bin.util.ImageBytes.readLimited;

/**
 * 用户消息清洗器 —— 根据模型的多模态支持情况清洗用户消息。
 * <p>
 * 主要职责：
 * <ul>
     *   <li>当模型不支持图片输入时，移除图片</li>
 *   <li>当模型不支持音频输入时，移除用户消息中的音频（预留）</li>
 *   <li>当模型不支持视频输入时，移除用户消息中的视频（预留）</li>
 * </ul>
 * </p>
 *
 * @author Sorghum
 */
@Slf4j
@Component
public class UserMessageSanitizer {
    private static final long MAX_IMAGE_BYTES = 5L * 1024 * 1024;
    private static final Path IMAGE_DIRECTORY = Path.of(".loopra", "read_img");
    private static final Pattern LEADING_COLLAPSIBLE_USER_BLOCK = Pattern.compile(
            "^```折叠块[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n```(?:\\r?\\n)*");

    @Inject
    public static ModelModalityProvider modalityProvider;

    /**
     * 清洗用户消息，根据模型的多模态支持情况移除不支持的内容。
     *
     * @param userMessage  原始用户消息
     * @param modelName  模型名称
     * @return 清洗后的用户消息，如果无需清洗则返回原消息
     */
    public static UserMessage sanitize(UserMessage userMessage, String modelName) {
        return sanitize(userMessage, modelName, null);
    }

    /**
     * 根据指定渠道内模型的能力清洗消息。
     */
    public static UserMessage sanitize(UserMessage userMessage, String modelName, String channelId) {
        return sanitize(userMessage, modelName, channelId, null);
    }

    /**
     * 根据指定模型能力清洗消息；非多模态模型的图片会先保存到项目目录，
     * 再用可供 {@code read_image} 使用的相对路径补回用户消息。
     */
    public static UserMessage sanitize(UserMessage userMessage, String modelName, String channelId,
                                       Path workspace) {
        if (userMessage == null || userMessage.isPlainText()) {
            return userMessage;
        }

        // 获取当前模型名称
        if (modelName == null || modelName.isEmpty()) {
            log.warn("[sanitizer] 无法获取当前模型名称，跳过消息清洗");
            return userMessage;
        }

        // 获取模型的多模态支持信息
        ModelModalityProvider provider = modalityProvider;
        if (provider == null) {
            log.debug("[sanitizer] 未配置模型多模态能力提供者，保留用户图片");
            return userMessage;
        }
        ModalitySupport modalitySupport = provider.getModalitySupport(channelId, modelName);
        if (modalitySupport == null) {
            log.debug("[sanitizer] 无法获取模型 '{}' 的多模态支持信息，跳过消息清洗", modelName);
            return userMessage;
        }

        // 模型不支持图片输入时，移除图片。
        List<String> images = userMessage.getImages();
        if (!images.isEmpty() && !modalitySupport.imageInput()) {
            log.info("[sanitizer] 模型 '{}' 不支持图片输入，将 {} 张图片保存到项目 .loopra/read_img 并移除原图",
                    modelName, images.size());
            return replaceImagesWithProjectPaths(userMessage, workspace);
        }

        // 未来可以扩展：清洗音频、视频等

        return userMessage;
    }

    /**
     * 使用实际发送请求的 Provider 确定模型和渠道，避免会话模型与全局配置串用。
     */
    public static UserMessage sanitize(UserMessage userMessage, LoopraModelProvider modelProvider) {
        if (modelProvider == null) return userMessage;
        return sanitize(userMessage, modelProvider.getModel(), modelProvider.getModelChannelId());
    }

    /** 使用实际模型和项目目录清洗消息。 */
    public static UserMessage sanitize(UserMessage userMessage, LoopraModelProvider modelProvider,
                                       Path workspace) {
        if (modelProvider == null) return userMessage;
        return sanitize(userMessage, modelProvider.getModel(), modelProvider.getModelChannelId(), workspace);
    }

    /**
     * 批量清洗用户消息列表。
     *
     * @param userMessages 用户消息列表
     * @param modelProvider 模型 Provider
     * @return 清洗后的用户消息列表
     */
    public static List<UserMessage> sanitize(List<UserMessage> userMessages, LoopraModelProvider modelProvider) {
        if (userMessages == null || userMessages.isEmpty()) {
            return userMessages;
        }

        List<UserMessage> sanitized = new ArrayList<>(userMessages.size());
        for (UserMessage msg : userMessages) {
            sanitized.add(sanitize(msg, modelProvider));
        }
        return sanitized;
    }

    private static UserMessage replaceImagesWithProjectPaths(UserMessage original, Path workspace) {
        List<String> paths = new ArrayList<>();
        List<String> failures = new ArrayList<>();
        Path projectRoot = workspace == null ? null : workspace.toAbsolutePath().normalize();
        Path imageDirectory = projectRoot == null ? null : projectRoot.resolve(IMAGE_DIRECTORY).normalize();

        for (int i = 0; i < original.getImages().size(); i++) {
            String image = original.getImages().get(i);
            try {
                Path saved = saveImage(image, imageDirectory);
                paths.add(projectRoot.relativize(saved).toString().replace('\\', '/'));
            } catch (Exception e) {
                String reason = e.getMessage();
                failures.add("第 " + (i + 1) + " 张图片保存失败"
                        + (reason == null || reason.isBlank() ? "" : "：" + reason));
                log.warn("[sanitizer] 用户图片保存失败: index={}, reason={}", i, reason);
            }
        }

        StringBuilder attachedContext = new StringBuilder();
        attachedContext.append("用户发送了 ").append(original.getImages().size())
                .append(" 张图片，但当前模型不支持直接查看图片。\n");
        if (!paths.isEmpty()) {
            attachedContext.append("图片已保存到项目目录。需要查看图片时，请调用 read_image，file_path 使用以下路径：\n");
            for (String path : paths) {
                attachedContext.append("- ").append(path).append('\n');
            }
            attachedContext.append("请根据用户需求设置 read_image 的 prompt；在读取前不要猜测图片内容。\n");
        }
        for (String failure : failures) {
            attachedContext.append(failure).append('\n');
        }
        if (paths.isEmpty() && failures.isEmpty()) {
            attachedContext.append("图片未能保存，请不要猜测图片内容。\n");
        }

        // ChatMessage.vue 已支持将前导折叠块显示为“附加上下文”；
        // 如果用户消息已经有折叠块（如技能/文件/项目上下文），直接合并，避免嵌套多个折叠块。
        String text = mergeAttachedContext(original.getText(), attachedContext.toString());

        UserMessage sanitized = UserMessage.of(text);
        copyMetadata(original, sanitized);
        return sanitized;
    }

    private static String mergeAttachedContext(String originalText, String attachedContext) {
        String source = originalText == null ? "" : originalText.trim();
        String generated = attachedContext == null ? "" : attachedContext.trim();
        if (generated.isEmpty()) {
            return source;
        }

        Matcher matcher = LEADING_COLLAPSIBLE_USER_BLOCK.matcher(source);
        if (matcher.find()) {
            String existingContext = matcher.group(1).trim();
            String remainder = source.substring(matcher.end()).trim();
            String combinedContext = existingContext.isEmpty()
                    ? generated
                    : existingContext + "\n\n" + generated;
            return "```折叠块\n" + combinedContext + "\n```"
                    + (remainder.isEmpty() ? "" : "\n\n" + remainder);
        }

        return "```折叠块\n" + generated + "\n```"
                + (source.isEmpty() ? "" : "\n\n" + source);
    }

    private static Path saveImage(String source, Path imageDirectory) throws IOException {
        if (imageDirectory == null) {
            throw new IOException("当前没有可用的项目目录");
        }
        ImageData image = readImage(source);
        Files.createDirectories(imageDirectory);
        String filename = "user-image-" + System.currentTimeMillis() + "-"
                + UUID.randomUUID().toString().replace("-", "") + "." + image.extension();
        Path target = imageDirectory.resolve(filename).normalize();
        if (!target.getParent().equals(imageDirectory)) {
            throw new IOException("图片保存路径无效");
        }
        Files.write(target, image.bytes(), StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE);
        return target;
    }

    private static ImageData readImage(String source) throws IOException {
        if (source == null || source.isBlank()) {
            throw new IOException("图片地址为空");
        }
        String value = source.trim();
        if (value.startsWith("data:")) {
            return decodeDataUri(value);
        }
        URI uri;
        try {
            uri = URI.create(value);
        } catch (IllegalArgumentException e) {
            throw new IOException("图片地址无效");
        }
        if (!"http".equalsIgnoreCase(uri.getScheme()) && !"https".equalsIgnoreCase(uri.getScheme())) {
            // 兼容 UserMessage 文档中约定的原始 Base64 图片。
            return decodeBase64(value, null);
        }

        URLConnection connection = uri.toURL().openConnection();
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(20_000);
        if (connection instanceof HttpURLConnection http) {
            http.setInstanceFollowRedirects(true);
            int status = http.getResponseCode();
            if (status < 200 || status >= 300) {
                throw new IOException("图片地址返回 HTTP " + status);
            }
        }
        long contentLength = connection.getContentLengthLong();
        if (contentLength > MAX_IMAGE_BYTES) {
            throw new IOException("图片大小超过 5 MiB 限制");
        }
        String mimeType = normalizeMimeType(connection.getContentType());
        byte[] bytes;
        try (InputStream input = connection.getInputStream()) {
            bytes = readLimited(input);
        } finally {
            if (connection instanceof HttpURLConnection http) http.disconnect();
        }
        if (mimeType == null) mimeType = mimeForExtension(extension(uri.getPath()));
        if (mimeType == null) mimeType = detectMimeType(bytes);
        return toImageData(bytes, mimeType);
    }

    private static ImageData decodeDataUri(String value) throws IOException {
        int comma = value.indexOf(',');
        int semicolon = value.indexOf(';');
        if (comma < 0 || semicolon < 0 || semicolon > comma
                || !value.substring(semicolon, comma).contains("base64")) {
            throw new IOException("图片 data URI 必须使用 Base64");
        }
        String mimeType = normalizeMimeType(value.substring("data:".length(), semicolon));
        return decodeBase64(value.substring(comma + 1), mimeType);
    }

    private static ImageData decodeBase64(String value, String mimeType) throws IOException {
        byte[] bytes;
        try {
            bytes = Base64.getDecoder().decode(value.replaceAll("\\s", ""));
        } catch (IllegalArgumentException e) {
            throw new IOException("图片 Base64 无效");
        }
        if (bytes.length > MAX_IMAGE_BYTES) {
            throw new IOException("图片大小超过 5 MiB 限制");
        }
        return toImageData(bytes, mimeType == null ? detectMimeType(bytes) : mimeType);
    }

    private static ImageData toImageData(byte[] bytes, String mimeType) throws IOException {
        String normalized = normalizeMimeType(mimeType);
        if (normalized == null) {
            throw new IOException("图片不是受支持的 PNG、JPEG、GIF 或 WebP 格式");
        }
        return new ImageData(bytes, normalized, extensionForMime(normalized));
    }

    private static String normalizeMimeType(String value) {
        if (value == null) return null;
        String mimeType = value.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
        return switch (mimeType) {
            case "image/png", "image/jpeg", "image/gif", "image/webp" -> mimeType;
            default -> null;
        };
    }

    private static String mimeForExtension(String extension) {
        return switch (extension == null ? "" : extension.toLowerCase(Locale.ROOT)) {
            case "png" -> "image/png";
            case "jpg", "jpeg" -> "image/jpeg";
            case "gif" -> "image/gif";
            case "webp" -> "image/webp";
            default -> null;
        };
    }

    private static String extensionForMime(String mimeType) {
        return switch (mimeType) {
            case "image/png" -> "png";
            case "image/jpeg" -> "jpg";
            case "image/gif" -> "gif";
            case "image/webp" -> "webp";
            default -> "img";
        };
    }

    private static String extension(String value) {
        if (value == null) return "";
        int query = value.indexOf('?');
        String name = query < 0 ? value : value.substring(0, query);
        int dot = name.lastIndexOf('.');
        return dot < 0 ? "" : name.substring(dot + 1);
    }

    private static void copyMetadata(UserMessage source, UserMessage target) {
        target.setSnapshotId(source.getSnapshotId());
        target.setRollbackId(source.getRollbackId());
        target.setWebHidden(source.isWebHidden());
    }

    private record ImageData(byte[] bytes, String mimeType, String extension) {
    }
}
