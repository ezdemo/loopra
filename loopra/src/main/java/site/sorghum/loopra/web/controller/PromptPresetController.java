package site.sorghum.loopra.web.controller;

import io.swagger.annotations.Api;
import io.swagger.annotations.ApiOperation;
import org.noear.snack4.ONode;
import org.noear.solon.annotation.Body;
import org.noear.solon.annotation.Controller;
import org.noear.solon.annotation.Get;
import org.noear.solon.annotation.Mapping;
import org.noear.solon.annotation.Put;
import site.sorghum.loopra.web.model.ApiResponse;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * 常用要求预设 API。
 * 预设属于服务端用户配置，不随浏览器 localStorage 保存。
 */
@Api(tags = "常用要求")
@Controller
@Mapping("/api/prompt-presets")
public class PromptPresetController {

    private static final Path PRESETS_FILE = Paths.get(
            System.getProperty("user.home"), ".loopra", "prompt-presets.json");

    private static final List<Map<String, String>> DEFAULT_PRESETS = List.of();

    @ApiOperation(value = "获取常用要求预设")
    @Get
    @Mapping("")
    public ApiResponse<List<Map<String, String>>> list() {
        try {
            if (!Files.exists(PRESETS_FILE)) {
                return ApiResponse.ok(copyPresets(DEFAULT_PRESETS));
            }
            String json = Files.readString(PRESETS_FILE, StandardCharsets.UTF_8);
            ONode root = ONode.ofJson(json);
            if (!root.isArray()) return ApiResponse.ok(copyPresets(DEFAULT_PRESETS));
            return ApiResponse.ok(readPresets(root));
        } catch (Exception e) {
            return ApiResponse.ok(copyPresets(DEFAULT_PRESETS));
        }
    }

    @ApiOperation(value = "保存常用要求预设")
    @Put
    @Mapping("")
    public ApiResponse<List<Map<String, String>>> save(@Body Map<String, Object> body) {
        Object rawPresets = body == null ? null : body.get("presets");
        if (!(rawPresets instanceof List<?> submitted)) {
            return ApiResponse.fail("预设数据格式不正确");
        }

        List<Map<String, String>> presets = new ArrayList<>();
        for (Object item : submitted) {
            if (!(item instanceof Map<?, ?> map)) {
                return ApiResponse.fail("预设数据格式不正确");
            }
            String label = text(map.get("label"));
            String text = text(map.get("text"));
            if (label.isBlank() || text.isBlank()) {
                return ApiResponse.fail("预设名称和要求内容不能为空");
            }
            if (label.length() > 24 || text.length() > 500) {
                return ApiResponse.fail("预设名称或要求内容过长");
            }
            String id = text(map.get("id"));
            presets.add(preset(id.isBlank() ? UUID.randomUUID().toString() : id, label, text));
        }

        try {
            Files.createDirectories(PRESETS_FILE.getParent());
            ONode root = ONode.ofJson("[]").asArray();
            for (Map<String, String> preset : presets) root.add(preset);
            Files.writeString(PRESETS_FILE, root.toJson(), StandardCharsets.UTF_8);
            return ApiResponse.ok(presets);
        } catch (Exception e) {
            return ApiResponse.fail("保存常用要求失败: " + e.getMessage());
        }
    }

    private static List<Map<String, String>> readPresets(ONode root) {
        List<Map<String, String>> presets = new ArrayList<>();
        for (ONode item : root.getArray()) {
            String id = text(item.get("id").getString());
            String label = text(item.get("label").getString());
            String content = text(item.get("text").getString());
            if (!label.isBlank() && !content.isBlank()) {
                presets.add(preset(id.isBlank() ? UUID.randomUUID().toString() : id, label, content));
            }
        }
        return presets;
    }

    private static Map<String, String> preset(String id, String label, String text) {
        Map<String, String> preset = new LinkedHashMap<>();
        preset.put("id", id);
        preset.put("label", label);
        preset.put("text", text);
        return preset;
    }

    private static List<Map<String, String>> copyPresets(List<Map<String, String>> source) {
        return source.stream().map(item -> preset(item.get("id"), item.get("label"), item.get("text"))).toList();
    }

    private static String text(Object value) {
        return value == null ? "" : value.toString().trim();
    }
}
