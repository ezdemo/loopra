package site.sorghum.loopra.integration;

import site.sorghum.cutin.core.plugin.PluginInstaller;
import site.sorghum.cutin.core.plugin.PluginPackageInfo;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/** JAR source validation, acquisition and hashing shared by both extension systems. */
public final class JarFiles {
    private final Path directory;
    private final String label;

    public JarFiles(Path directory, String label) {
        this.directory = directory;
        this.label = label;
    }

    public String requireSource(String sourceUrl) {
        if (sourceUrl == null || sourceUrl.isBlank()) {
            throw new IllegalArgumentException(label + "来源不能为空");
        }
        String trimmed = sourceUrl.trim();
        if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
            String lower = trimmed.toLowerCase();
            int query = lower.indexOf('?');
            String pathPart = query >= 0 ? lower.substring(0, query) : lower;
            if (!pathPart.endsWith(".jar")) {
                throw new IllegalArgumentException("仅支持以 .jar 结尾的直链: " + trimmed);
            }
            return trimmed;
        }
        // 本地路径：校验存在且是普通文件
        Path local = Paths.get(trimmed);
        if (!Files.isRegularFile(local)) {
            throw new IllegalArgumentException("本地" + label + " jar 不存在: " + trimmed);
        }
        if (!local.getFileName().toString().toLowerCase().endsWith(".jar")) {
            throw new IllegalArgumentException("仅支持以 .jar 结尾的插件文件: " + trimmed);
        }
        return local.toAbsolutePath().toString();
    }

    public static String[] inferIdAndVersion(String source) {
        String path = source.toLowerCase();
        int query = path.indexOf('?');
        if (query >= 0) {
            path = path.substring(0, query);
        }
        int nameStart = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
        String fileName = path.substring(nameStart + 1, path.length() - ".jar".length());
        int split = fileName.lastIndexOf('-');
        if (split > 0) {
            return new String[]{fileName.substring(0, split), fileName.substring(split + 1)};
        }
        return new String[]{fileName, "unknown"};
    }

    public Path acquire(String source, String id, String version) {
        if (source.startsWith("http://") || source.startsWith("https://")) {
            return download(source, id, version);
        }
        return copyLocalJar(Paths.get(source));
    }

    private Path copyLocalJar(Path source) {
        try {
            Files.createDirectories(directory);
            Path target = directory.resolve(source.getFileName().toString());
            Files.copy(source, target, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            return target;
        } catch (IOException exception) {
            throw new IllegalStateException(label + " jar 复制失败: " + source, exception);
        }
    }

    private Path download(String url, String id, String version) {
        try {
            PluginPackageInfo info =
                new PluginPackageInfo(id, version, url);
            return new PluginInstaller(directory).install(info);
        } catch (IOException exception) {
            throw new IllegalStateException(label + "下载失败: " + url, exception);
        }
    }

    public static String sha256(Path file) {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 unavailable", exception);
        }
        try (InputStream input = Files.newInputStream(file)) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) > 0) {
                digest.update(buffer, 0, read);
            }
        } catch (IOException exception) {
            throw new IllegalStateException("读取文件失败: " + file, exception);
        }
        return HexFormat.of().formatHex(digest.digest());
    }
}
