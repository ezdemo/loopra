package site.sorghum.loopra.web.controller;

import io.swagger.annotations.Api;
import io.swagger.annotations.ApiOperation;
import io.swagger.annotations.ApiParam;
import lombok.SneakyThrows;
import lombok.extern.slf4j.Slf4j;
import org.noear.solon.annotation.Controller;
import org.noear.solon.annotation.Get;
import org.noear.solon.annotation.Mapping;
import org.noear.solon.annotation.Param;
import org.noear.solon.annotation.Post;
import site.sorghum.loopra.tool.solon.common.LoopraSkillProvider;
import site.sorghum.loopra.web.market.Market;
import site.sorghum.loopra.web.market.MarketDetail;
import site.sorghum.loopra.web.market.MarketItem;
import site.sorghum.loopra.web.market.MarketManager;
import site.sorghum.loopra.web.model.ApiResponse;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

/**
 * 技能市场 API 控制器 — 提供技能市场的浏览、搜索和安装能力。
 *
 * <p>所有外部 API 调用均由后端 Market 适配器完成，前端不直接访问外部服务。</p>
 *
 * @author Sorghum
 */
@Api(tags = "技能市场")
@Controller
@Mapping("/api/skill-market")
@Slf4j
public class SkillMarketController {

    private final MarketManager marketManager;

    public SkillMarketController() {
        this.marketManager = new MarketManager();
    }

    @ApiOperation(value = "获取可用市场列表", notes = "返回所有已注册的技能市场名称和描述")
    @Get
    @Mapping("/markets")
    public ApiResponse<List<MarketManager.MarketInfo>> markets() {
        return ApiResponse.ok(marketManager.getMarketInfos());
    }

    @ApiOperation(value = "浏览热门技能或搜索技能", notes = "通过 action 参数区分 trending（热门）和 search（搜索）模式")
    @Get
    @Mapping("/proxy")
    public ApiResponse<List<MarketItem>> proxy(
            @ApiParam(value = "操作类型：trending 获取热门 | search 搜索")
            @Param(value = "action", defaultValue = "trending") String action,
            @ApiParam(value = "搜索关键词（action=search 时使用）")
            @Param(value = "q", defaultValue = "") String query,
            @ApiParam(value = "返回数量限制")
            @Param(value = "limit", defaultValue = "50") int limit,
            @ApiParam(value = "市场名称（可选，默认使用 skillhub.cn）")
            @Param(value = "marketName", defaultValue = "") String marketName) {
        Market market = marketManager.getMarketByName(marketName);
        List<MarketItem> items;
        if ("search".equals(action) && query != null && !query.isEmpty()) {
            items = market.search(query, limit);
        } else {
            items = market.trending(limit);
        }
        return ApiResponse.ok(items);
    }

    @ApiOperation(value = "获取技能详情", notes = "根据 slug 获取技能的详细信息")
    @Get
    @Mapping("/detail")
    public ApiResponse<MarketDetail> detail(
            @ApiParam(value = "技能 slug", required = true) @Param(value = "slug", required = true) String slug,
            @ApiParam(value = "市场名称（可选）") @Param(value = "marketName", defaultValue = "") String marketName) {
        if (slug == null || slug.isEmpty()) {
            return ApiResponse.fail("slug is required");
        }
        Market market = marketManager.getMarketByName(marketName);
        MarketDetail detail = market.detail(slug);
        return ApiResponse.ok(detail);
    }

    @ApiOperation(value = "安装技能", notes = "从市场下载并安装技能到本地技能池")
    @Post
    @Mapping("/install")
    public ApiResponse<String> install(
            @ApiParam(value = "技能 slug", required = true) @Param(value = "slug", required = true) String slug,
            @ApiParam(value = "市场名称（可选）") @Param(value = "marketName", defaultValue = "") String marketName) {
        if (slug == null || slug.isEmpty()) {
            return ApiResponse.fail("slug is required");
        }

        Market market = marketManager.getMarketByName(marketName);

        // 与 Agent 技能池使用同一个唯一目录。
        Path skillsDir = getSkillsInstallDir();

        String displayName = market.install(slug, skillsDir);
        LoopraSkillProvider.refreshAllSkillPools();

        log.info("技能安装成功: {} ({})", displayName, slug);
        return ApiResponse.ok(displayName);
    }

    @ApiOperation(value = "卸载技能", notes = "从本地技能池删除已安装的技能")
    @Post
    @Mapping("/uninstall")
    public ApiResponse<Void> uninstall(
            @ApiParam(value = "技能 slug", required = true) @Param(value = "slug", required = true) String slug,
            @ApiParam(value = "技能来源标识（可选）") @Param(value = "scope", defaultValue = "") String scope) {
        if (slug == null || slug.isEmpty()) {
            return ApiResponse.fail("slug is required");
        }

        if (isBuiltinSkill(scope) || isBuiltinSkill(slug)) {
            return ApiResponse.fail("内置技能不可卸载");
        }

        if (!slug.matches("[a-zA-Z0-9._-]+") || ".".equals(slug) || "..".equals(slug)) {
            return ApiResponse.fail("Invalid slug");
        }

        Path skillsDir = getSkillsInstallDir();
        Path targetDir = findSkillDirectory(skillsDir, slug);

        if (targetDir == null) {
            return ApiResponse.fail("技能未找到: " + slug);
        }

        deleteDirectory(targetDir);
        LoopraSkillProvider.refreshAllSkillPools();
        log.info("技能卸载成功: {}", slug);
        return ApiResponse.ok(null);
    }

    private boolean isBuiltinSkill(String id) {
        return id != null && (id.equals(LoopraSkillProvider.BUILTIN_SKILLS_ALIAS)
                || id.startsWith(LoopraSkillProvider.BUILTIN_SKILLS_ALIAS + "/"));
    }

    @SneakyThrows
    private void deleteDirectory(Path dir){
        if (!Files.exists(dir)) return;
        Files.walk(dir)
                .sorted(Comparator.reverseOrder())
                .forEach(p -> {
                    try {
                        Files.delete(p);
                    } catch (Exception ignored) {
                        log.debug("删除技能文件失败: {}", p);
                    }
                });
    }

    /** 获取 Loopra 唯一的技能安装目录。 */
    private Path getSkillsInstallDir() {
        return Paths.get(System.getProperty("user.home"), ".loopra", "skills");
    }

    /**
     * 市场技能通常以 slug 作为目录名；对于手动安装或第三方工具保留作者前缀的情况，
     * 再根据 SKILL.md frontmatter 中的 name 定位实际目录。
     */
    private Path findSkillDirectory(Path skillsDir, String slug) {
        Path directDir = skillsDir.resolve(slug);
        if (Files.isDirectory(directDir)) {
            return directDir;
        }
        if (!Files.isDirectory(skillsDir)) {
            return null;
        }

        try (Stream<Path> entries = Files.list(skillsDir)) {
            return entries
                    .filter(Files::isDirectory)
                    .filter(dir -> hasSkillName(dir, slug))
                    .findFirst()
                    .orElse(null);
        } catch (IOException e) {
            log.warn("扫描技能目录失败: {}", skillsDir, e);
            return null;
        }
    }

    private boolean hasSkillName(Path skillDir, String slug) {
        Path skillFile = skillDir.resolve("SKILL.md");
        if (!Files.isRegularFile(skillFile)) {
            return false;
        }

        try (BufferedReader reader = Files.newBufferedReader(skillFile, StandardCharsets.UTF_8)) {
            if (!"---".equals(reader.readLine())) {
                return false;
            }

            String line;
            while ((line = reader.readLine()) != null && !"---".equals(line)) {
                if (line.startsWith("name:")) {
                    String name = line.substring("name:".length()).trim();
                    if (name.length() > 1 && ((name.startsWith("\"") && name.endsWith("\""))
                            || (name.startsWith("'") && name.endsWith("'")))) {
                        name = name.substring(1, name.length() - 1);
                    }
                    return slug.equals(name);
                }
            }
        } catch (IOException e) {
            log.debug("读取技能定义失败: {}", skillFile, e);
        }
        return false;
    }
}
