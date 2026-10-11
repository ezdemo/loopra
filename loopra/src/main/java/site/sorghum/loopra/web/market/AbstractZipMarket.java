package site.sorghum.loopra.web.market;

import lombok.SneakyThrows;
import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.ONode;
import org.noear.solon.net.http.HttpResponse;
import org.noear.solon.net.http.HttpUtils;

import java.io.BufferedInputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Comparator;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * 抽象 ZIP 技能市场基类 — 封装 HTTP 请求、ZIP 下载/解压/安装等通用逻辑。
 *
 * <p>子类只需实现市场特有的 API 调用（trending/search/detail），
 * 安装、HTTP 工具、Zip 安全解压等由本类统一提供。</p>
 *
 * @author Sorghum
 */
@Slf4j
public abstract class AbstractZipMarket implements Market {

    @SneakyThrows
    @Override
    public String install(String slug, Path skillsDir){
        if (slug == null || slug.isEmpty()) {
            throw new IllegalArgumentException("slug is required");
        }

        slug = slug.replaceAll("[^a-zA-Z0-9._-]", "");
        if (slug.isEmpty()) {
            throw new IllegalArgumentException("Invalid slug");
        }

        MarketDetail detailResult = detail(slug);
        String displayName = detailResult.getDisplayName();
        if (displayName == null || displayName.isEmpty()) {
            displayName = slug;
        }

        String downloadUrl = buildDownloadUrl(slug);

        Files.createDirectories(skillsDir);

        Path tempZip = Files.createTempFile("skill-", ".zip");
        try {
            HttpResponse httpResp = HttpUtils.http(downloadUrl)
                    .header("User-Agent", userAgent())
                    .timeout(30000)
                    .exec("GET");

            byte[] zipBytes = httpResp.bodyAsBytes();
            if (zipBytes == null || zipBytes.length == 0) {
                throw new RuntimeException("下载技能包失败: 返回内容为空");
            }
            Files.write(tempZip, zipBytes);

            if (Files.size(tempZip) == 0) {
                throw new RuntimeException("下载技能包失败: 文件为空");
            }

            Path targetDir = skillsDir.resolve(slug);
            if (Files.exists(targetDir)) {
                deleteDirectory(targetDir);
            }

            unzipToDirectory(tempZip, targetDir);

            log.info("{}.install: {} -> {}", name(), slug, targetDir);
            return displayName;
        } finally {
            Files.deleteIfExists(tempZip);
        }
    }

    /**
     * 构建技能包下载 URL。
     *
     * @param slug 技能标识
     * @return 完整的下载 URL
     */
    protected abstract String buildDownloadUrl(String slug) throws Exception;

    /**
     * 获取 HTTP 请求使用的 User-Agent。
     */
    protected String userAgent() {
        return "Loopra/1.0";
    }

    // ==================== HTTP 工具 ====================

    /**
     * 执行 HTTP GET 请求并返回响应体字符串。
     */
    protected String httpGet(String url) {
        return HttpUtils.http(url)
                .header("User-Agent", userAgent())
                .timeout(15000)
                .get();
    }

    // ==================== JSON 工具 ====================

    /**
     * 从 ONode 中安全读取字符串字段。
     */
    protected String getStringValue(ONode node, String key) {
        ONode child = node.get(key);
        return (child != null && !child.isNull()) ? child.getString() : null;
    }

    /**
     * 从 ONode 中安全读取长整型字段。
     */
    protected long getLongValue(ONode node, String key) {
        ONode child = node.get(key);
        return (child != null && !child.isNull()) ? child.getLong() : 0;
    }

    // ==================== 文件工具 ====================

    /**
     * 递归删除目录。
     */
    @SneakyThrows
    protected void deleteDirectory(Path dir){
        if (!Files.exists(dir)) return;
        Files.walk(dir)
                .sorted(Comparator.reverseOrder())
                .forEach(p -> {
                    try {
                        Files.delete(p);
                    } catch (Exception ignored) {
                        // 单个文件删除失败不影响其余清理
                    }
                });
    }

    /**
     * 安全解压 ZIP 文件到目标目录（含 Zip Slip 防护）。
     */
    @SneakyThrows
    protected void unzipToDirectory(Path zipFile, Path targetDir){
        ZipInputStream zis = new ZipInputStream(new BufferedInputStream(Files.newInputStream(zipFile)));
        try {
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                Path entryPath = targetDir.resolve(entry.getName()).normalize();

                // Zip Slip 防护：确保解压路径在目标目录内
                if (!entryPath.startsWith(targetDir.normalize())) {
                    continue;
                }

                if (entry.isDirectory()) {
                    Files.createDirectories(entryPath);
                } else {
                    Files.createDirectories(entryPath.getParent());
                    Files.copy(zis, entryPath, StandardCopyOption.REPLACE_EXISTING);
                }
                zis.closeEntry();
            }
        } finally {
            zis.close();
        }
    }

    // ==================== 通用工具 ====================

    /**
     * 取第一个非空字符串。
     */
    protected String firstNonEmpty(String... values) {
        for (String v : values) {
            if (v != null && !v.isEmpty()) {
                return v;
            }
        }
        return null;
    }
}
