package site.sorghum.loopra.web.controller;

import io.swagger.annotations.Api;
import io.swagger.annotations.ApiOperation;
import lombok.SneakyThrows;
import org.noear.snack4.ONode;
import org.noear.solon.annotation.Body;
import org.noear.solon.annotation.Controller;
import org.noear.solon.annotation.Delete;
import org.noear.solon.annotation.Get;
import org.noear.solon.annotation.Inject;
import org.noear.solon.annotation.Mapping;
import org.noear.solon.annotation.Param;
import org.noear.solon.annotation.Put;
import org.noear.solon.core.handle.Context;
import site.sorghum.loopra.bin.config.ConfigService;
import site.sorghum.loopra.web.model.ApiResponse;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * 桌面宠物 API — 支持多宠物选择。
 * <p>
 * 宠物文件位于 {@code ~/.petdex/pets/} 目录，每个子文件夹代表一个宠物，
 * 内含 pet.json（元数据）和 spritesheet.webp（精灵图）。
 * 当前活跃宠物名称写入 config.json 的 activePet 字段。
 * </p>
 *
 * @author Sorghum
 */
@Api(tags = "宠物")
@Controller
@Mapping("/api/pets")
public class PetController {

    private static final Path PETS_DIR =
            Paths.get(System.getProperty("user.home"), ".petdex", "pets");

    private static final Path POSITION_DIR =
            Paths.get(System.getProperty("user.home"), ".loopra", "pet");

    private static final Path POSITION_FILE = POSITION_DIR.resolve("position.json");
    private static final double MIN_PET_SCALE = 0.25d;
    private static final double MAX_PET_SCALE = 1.25d;

    @Inject
    private ConfigService configService;

    // ──────────────────── 列出所有可用宠物 ────────────────────

    @ApiOperation(value = "列出所有可用宠物", notes = "扫描 ~/.petdex/pets/ 子文件夹，返回每个宠物的元数据摘要")
    @Get
    @Mapping("")
    @SneakyThrows
    public ApiResponse<List<Map<String, Object>>> listPets() {
        if (!Files.isDirectory(PETS_DIR)) {
            return ApiResponse.ok(Collections.emptyList());
        }

        List<Map<String, Object>> pets;
        try (Stream<Path> dirs = Files.list(PETS_DIR)) {
            pets = dirs
                    .filter(Files::isDirectory)
                    .map(dir -> {
                        Map<String, Object> info = new LinkedHashMap<>();
                        String name = dir.getFileName().toString();
                        info.put("name", name);
                        info.put("dirName", name);

                        Path meta = dir.resolve("pet.json");
                        if (Files.exists(meta)) {
                            try {
                                ONode metaNode = ONode.ofJson(Files.readString(meta, StandardCharsets.UTF_8));
                                info.put("displayName", metaNode.get("name") != null
                                        ? metaNode.get("name").getString() : name);
                                info.put("description", metaNode.get("description") != null
                                        ? metaNode.get("description").getString() : "");
                                if (metaNode.get("author") != null) {
                                    info.put("author", metaNode.get("author").getString());
                                }
                            } catch (Exception ignored) {
                                info.put("displayName", name);
                                info.put("description", "");
                            }
                        } else {
                            info.put("displayName", name);
                            info.put("description", "");
                        }

                        Path sheet = dir.resolve("spritesheet.webp");
                        info.put("hasSpritesheet", Files.exists(sheet));
                        info.put("spritesheetUrl", "/api/pets/" + name + "/spritesheet");

                        return info;
                    })
                    .collect(Collectors.toList());
        }
        return ApiResponse.ok(pets);
    }

    // ──────────────────── 获取指定宠物元数据 ────────────────────

    @ApiOperation(value = "获取指定宠物元数据", notes = "返回宠物目录下 pet.json 的内容")
    @Get
    @Mapping("/{name}")
    @SneakyThrows
    public ApiResponse<?> getPetInfo(@Param("name") String name) {
        Path petDir = PETS_DIR.resolve(name);
        if (!Files.isDirectory(petDir)) {
            return ApiResponse.fail("宠物不存在: " + name);
        }
        Path meta = petDir.resolve("pet.json");
        if (!Files.exists(meta)) {
            return ApiResponse.ok("{}");
        }
        ONode root = ONode.ofJson(Files.readString(meta, StandardCharsets.UTF_8));
        root.set("dirName", name);
        return ApiResponse.ok(root);
    }

    // ──────────────────── 获取宠物精灵图 ────────────────────

    @ApiOperation(value = "获取宠物 spritesheet", notes = "返回 spritesheet.webp 文件字节")
    @Get
    @Mapping("/{name}/spritesheet")
    @SneakyThrows
    public void getSpritesheet(@Param("name") String name) {
        Context current = Context.current();
        Path petDir = PETS_DIR.resolve(name);
        if (!Files.isDirectory(petDir)) {
            current.status(404);
            return;
        }
        Path sheet = petDir.resolve("spritesheet.webp");
        if (!Files.exists(sheet)) {
            current.status(404);
            return;
        }
        current.headerSet("Content-Type", "image/webp");
        current.headerSet("Cache-Control", "no-cache");
        current.output(Files.readAllBytes(sheet));
    }

    // ──────────────────── 获取/设置活跃宠物 ────────────────────

    @ApiOperation(value = "获取当前活跃宠物", notes = "返回 config.json 中 activePet 指定的宠物信息，含位置/大小")
    @Get
    @Mapping("/active")
    @SneakyThrows
    public ApiResponse<?> getActivePet() {
        String activeName = configService.getConfig().activePet();
        if (activeName == null || activeName.isEmpty()) {
            return ApiResponse.ok(Collections.singletonMap("active", false));
        }

        Path petDir = PETS_DIR.resolve(activeName);
        if (!Files.isDirectory(petDir)) {
            return ApiResponse.ok(Collections.singletonMap("active", false));
        }

        Map<String, Object> result = new LinkedHashMap<>();
        result.put("active", true);
        result.put("name", activeName);

        Path meta = petDir.resolve("pet.json");
        if (Files.exists(meta)) {
            try {
                ONode metaNode = ONode.ofJson(Files.readString(meta, StandardCharsets.UTF_8));
                result.put("displayName", metaNode.get("name") != null
                        ? metaNode.get("name").getString() : activeName);
                result.put("description", metaNode.get("description") != null
                        ? metaNode.get("description").getString() : "");
            } catch (Exception ignored) {
                result.put("displayName", activeName);
            }
        } else {
            result.put("displayName", activeName);
        }

        result.put("position", readPetPosition());
        result.put("sizeIndex", readPetSizeIndex());
        Double scale = readPetScale();
        if (scale != null) result.put("scale", scale);
        result.put("spritesheetUrl", "/api/pets/" + activeName + "/spritesheet");

        return ApiResponse.ok(result);
    }

    @ApiOperation(value = "设置活跃宠物", notes = "将宠物名称写入 config.json 的 activePet 字段")
    @Put
    @Mapping("/active")
    @SneakyThrows
    public ApiResponse<String> setActivePet(@Body Map<String, Object> body) {
        Object nameObj = body.get("name");
        if (nameObj == null || nameObj.toString().isEmpty()) {
            return ApiResponse.fail("宠物名称不能为空");
        }
        String name = nameObj.toString();

        Path petDir = PETS_DIR.resolve(name);
        if (!Files.isDirectory(petDir)) {
            return ApiResponse.fail("宠物不存在: " + name);
        }

        configService.updateConfig(Map.of("activePet", name));
        return ApiResponse.ok("已切换到宠物: " + name);
    }

    // ──────────────────── 删除宠物（清空文件夹） ────────────────────

    @ApiOperation(value = "删除宠物", notes = "删除指定宠物的整个目录（清空 pet 文件夹）")
    @Delete
    @Mapping("/{name}")
    @SneakyThrows
    public ApiResponse<String> deletePet(@Param("name") String name) {
        Path petDir = PETS_DIR.resolve(name);
        if (!Files.isDirectory(petDir)) {
            return ApiResponse.fail("宠物不存在: " + name);
        }
        // 递归删除宠物目录
        try (var walk = Files.walk(petDir)) {
            walk.sorted(java.util.Comparator.reverseOrder())
                    .forEach(p -> {
                        try {
                            Files.deleteIfExists(p);
                        } catch (Exception ignored) {
                            // 单个文件删除失败不影响其余清理
                        }
                    });
        }
        // 如果已激活该宠物则清除 activePet
        String activeName = configService.getConfig().activePet();
        if (name.equals(activeName)) {
            configService.updateConfig(Map.of("activePet", ""));
        }
        return ApiResponse.ok("宠物已删除: " + name);
    }

    // ──────────────────── 保存宠物位置/大小 ────────────────────

    @ApiOperation(value = "保存宠物位置/大小", notes = "将拖动位置和大小写入位置存储")
    @Put
    @Mapping("/position")
    @SneakyThrows
    public ApiResponse<?> savePosition(@Body Map<String, Object> pos) {
        savePetPosition(pos);
        return ApiResponse.ok("位置已保存");
    }

    // ──────────────────── 内部：全局位置存储 (~/.loopra/pet/position.json) ────────────────────

    private Map<String, Object> readPetPosition() {
        Map<String, Object> pos = new LinkedHashMap<>();
        pos.put("x", 0);
        pos.put("y", 0);
        try {
            if (Files.exists(POSITION_FILE)) {
                ONode node = ONode.ofJson(Files.readString(POSITION_FILE, StandardCharsets.UTF_8));
                if (node.get("x") != null) pos.put("x", node.get("x").getInt());
                if (node.get("y") != null) pos.put("y", node.get("y").getInt());
            }
        } catch (Exception ignored) {
            // 位置文件缺失或损坏时使用默认值
        }
        return pos;
    }

    private int readPetSizeIndex() {
        try {
            if (Files.exists(POSITION_FILE)) {
                ONode node = ONode.ofJson(Files.readString(POSITION_FILE, StandardCharsets.UTF_8));
                if (node.get("sizeIndex") != null) return node.get("sizeIndex").getInt();
            }
        } catch (Exception ignored) {
            // 尺寸配置缺失或损坏时使用默认值
        }
        return 1;
    }

    private Double readPetScale() {
        try {
            if (Files.exists(POSITION_FILE)) {
                ONode node = ONode.ofJson(Files.readString(POSITION_FILE, StandardCharsets.UTF_8));
                if (node.get("scale") != null) {
                    double scale = node.get("scale").getDouble();
                    if (Double.isFinite(scale) && scale >= MIN_PET_SCALE && scale <= MAX_PET_SCALE) return scale;
                }
            }
        } catch (Exception ignored) {
            // 缩放配置缺失或损坏时返回 null
        }
        return null;
    }

    @SneakyThrows
    private void savePetPosition(Map<String, Object> pos) {
        Files.createDirectories(POSITION_DIR);
        ONode root;
        if (Files.exists(POSITION_FILE)) {
            root = ONode.ofJson(Files.readString(POSITION_FILE, StandardCharsets.UTF_8));
        } else {
            root = ONode.ofJson("{}").asObject();
        }
        if (pos.containsKey("x")) root.set("x", pos.get("x"));
        if (pos.containsKey("y")) root.set("y", pos.get("y"));
        if (pos.containsKey("sizeIndex")) root.set("sizeIndex", pos.get("sizeIndex"));
        if (pos.containsKey("scale")) {
            try {
                double scale = Double.parseDouble(String.valueOf(pos.get("scale")));
                if (Double.isFinite(scale) && scale >= MIN_PET_SCALE && scale <= MAX_PET_SCALE) {
                    root.set("scale", scale);
                }
            } catch (NumberFormatException ignored) {
                // 非法缩放值直接跳过
            }
        }
        Files.writeString(POSITION_FILE, root.toJson(), StandardCharsets.UTF_8);
    }
}
