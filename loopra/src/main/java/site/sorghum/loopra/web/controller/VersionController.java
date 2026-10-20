package site.sorghum.loopra.web.controller;

import io.swagger.annotations.Api;
import io.swagger.annotations.ApiOperation;
import lombok.extern.slf4j.Slf4j;
import org.noear.solon.annotation.Controller;
import org.noear.solon.annotation.Body;
import org.noear.solon.annotation.Get;
import org.noear.solon.annotation.Inject;
import org.noear.solon.annotation.Mapping;
import org.noear.solon.annotation.Post;
import site.sorghum.loopra.web.model.ApiResponse;
import site.sorghum.loopra.web.model.SystemVersionDTO;
import site.sorghum.loopra.web.model.VersionCheckDTO;
import site.sorghum.loopra.web.model.VersionUpdateDTO;
import site.sorghum.loopra.web.model.VersionUpdateRequest;
import site.sorghum.loopra.web.service.VersionUpdateService;

import java.net.HttpURLConnection;
import java.net.URL;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

/**
 * 版本管理端点 — 获取当前版本信息、检查远程最新版本。
 * <p>
 * 版本号通过 Maven 资源过滤从 {@code pom.xml} 自动注入到 {@code app.yml} 的 {@code solon.app.version} 中，
 * 运行时通过 Solon 配置读取，无需手动维护。
 * </p>
 *
 * @author Sorghum
 */
@Slf4j
@Api(tags = "版本")
@Controller
@Mapping("/api/version")
public class VersionController {

    @Inject
    private VersionUpdateService versionUpdateService;

    /**
     * 最新发布页地址（独立发版仓库）。通过访问其 302 重定向目标地址提取最新版本标签。
     */
    private static final String LATEST_RELEASE_URL = "https://github.com/ezdemo/loopra-release/releases/latest";

    private static final String GITHUB_LATEST_RELEASE_URL = "https://github.com/ezdemo/loopra-release/releases/latest";

    /**
     * 获取当前系统版本信息。
     *
     * @return 当前版本号、构建时间、应用名称
     */
    @ApiOperation(value = "获取当前版本", notes = "返回当前 Loopra 的版本号、构建时间和应用名称")
    @Get
    @Mapping("/")
    public ApiResponse<SystemVersionDTO> currentVersion() {
        String version = org.noear.solon.Solon.cfg().get("solon.app.version");
        String name = org.noear.solon.Solon.cfg().get("solon.app.name");
        if (version == null || version.isEmpty()) {
            version = "unknown";
        }
        return ApiResponse.ok(new SystemVersionDTO(version, "", name));
    }

    /**
     * 检查远程最新版本，与当前版本比较后返回结果。
     * <p>
     * 通过访问 {@link #LATEST_RELEASE_URL} 的 302 重定向目标地址
     * 来提取最新版本标签（例如重定向到 {@code /releases/tag/v26.6.15} 得到版本 {@code 26.6.15}），
     * 比直接调用 GitHub API 更稳定（不受 API 频率限制和格式变更影响）。
     * </p>
     *
     * @return 版本检查结果（当前版本、最新版本、是否有更新、发布说明等）
     */
    @ApiOperation(value = "检查最新版本", notes = "通过访问 releases/latest 的 302 重定向目标地址提取最新版本号")
    @Get
    @Mapping("/check")
    public ApiResponse<VersionCheckDTO> checkLatestVersion() {
        String currentVersion = org.noear.solon.Solon.cfg().get("solon.app.version");
        if (currentVersion == null || currentVersion.isEmpty()) {
            currentVersion = "unknown";
        }

        String checkTime = LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss"));

        try {

            // 发送请求，不跟随重定向，获取 Location 头中的最新版本标签
            URL url = new URL(LATEST_RELEASE_URL);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(10000);
            conn.setRequestProperty("User-Agent", "Loopra/" + currentVersion);
            conn.setRequestMethod("GET");
            conn.connect();

            int statusCode = conn.getResponseCode();
            String latestVersion = null;
            String releaseUrl = null;

            // 读取重定向响应中的 Location 头
            if (statusCode >= 300 && statusCode < 400) {
                String location = conn.getHeaderField("Location");
                if (location != null && !location.isEmpty()) {
                    // 从 Location 中提取版本标签
                    // 格式如: https://github.com/ezdemo/loopra-release/releases/tag/v26.6.15
                    int tagIndex = location.lastIndexOf("/tag/");
                    if (tagIndex >= 0) {
                        String tagName = location.substring(tagIndex + 5); // "/tag/" 长度为 5
                        latestVersion = tagName.replaceFirst("^[vV]", "");
                        releaseUrl = location;
                    }
                }
            }
            conn.disconnect();

            if (latestVersion == null) {
                // 如果通过重定向方式获取失败，记录详细日志
                throw new RuntimeException("无法从重定向中获取最新版本号 (HTTP " + statusCode + ")");
            }

            boolean hasNewVersion = false;
            if (!currentVersion.equals("unknown")) {
                hasNewVersion = compareVersions(latestVersion, currentVersion) > 0;
            }

            return ApiResponse.ok(new VersionCheckDTO(
                    currentVersion,
                    latestVersion,
                    hasNewVersion,
                    GITHUB_LATEST_RELEASE_URL,
                    null, // 通过重定向方式无法获取发布说明
                    checkTime
            ));
        } catch (Exception e) {
            log.warn("检查最新版本失败: {}", e.getMessage());
            // 检查失败时返回当前版本信息，标记无新版本
            return ApiResponse.ok(new VersionCheckDTO(
                    currentVersion,
                    currentVersion,
                    false,
                    null,
                    "版本检查失败: " + e.getMessage(),
                    checkTime
            ));
        }
    }

    /**
     * 在当前机器上直接启动核心服务更新。
     *
     * <p>Java 服务会自动识别 CLI / 桌面运行时和操作系统，在独立进程执行
     * 官方更新脚本。当前进程保持运行。</p>
     */
    @ApiOperation(value = "自动更新核心服务",
            notes = "由 Java 服务识别平台并后台执行更新脚本，不会创建 Agent 会话")
    @Post
    @Mapping("/update")
    public ApiResponse<VersionUpdateDTO> update(@Body VersionUpdateRequest request) {
        return ApiResponse.ok(versionUpdateService.start(request == null ? null : request.getSource()));
    }

    /**
     * 获取当前更新任务的状态与日志。
     */
    @ApiOperation(value = "获取核心服务更新状态", notes = "返回任务状态、日志文件路径和最近的日志内容")
    @Get
    @Mapping("/update")
    public ApiResponse<VersionUpdateDTO> updateStatus() {
        return ApiResponse.ok(versionUpdateService.status());
    }

    /**
     * 停止当前正在执行的核心服务更新。
     */
    @ApiOperation(value = "停止核心服务更新", notes = "停止更新进程并保留已经产生的日志")
    @Post
    @Mapping("/update/stop")
    public ApiResponse<VersionUpdateDTO> stopUpdate() {
        return ApiResponse.ok(versionUpdateService.stop());
    }

    /**
     * 比较两个语义化版本号（x.y.z 格式）。
     *
     * @param v1 版本 A
     * @param v2 版本 B
     * @return v1 &gt; v2 返回正数，v1 &lt; v2 返回负数，相等返回 0
     */
    private int compareVersions(String v1, String v2) {
        String[] parts1 = v1.split("\\.");
        String[] parts2 = v2.split("\\.");
        int len = Math.max(parts1.length, parts2.length);
        for (int i = 0; i < len; i++) {
            int num1 = i < parts1.length ? parseIntSafe(parts1[i]) : 0;
            int num2 = i < parts2.length ? parseIntSafe(parts2[i]) : 0;
            if (num1 != num2) {
                return num1 - num2;
            }
        }
        return 0;
    }

    /**
     * 安全地将字符串解析为整数，解析失败时返回 0。
     */
    private int parseIntSafe(String str) {
        // 只取数字部分（忽略 pre-release 标签如 "12-beta" -> 12）
        StringBuilder digits = new StringBuilder();
        for (char c : str.toCharArray()) {
            if (Character.isDigit(c)) {
                digits.append(c);
            } else {
                break;
            }
        }
        if (digits.isEmpty()) return 0;
        try {
            return Integer.parseInt(digits.toString());
        } catch (NumberFormatException e) {
            return 0;
        }
    }
}
