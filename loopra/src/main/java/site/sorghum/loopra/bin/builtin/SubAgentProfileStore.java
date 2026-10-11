package site.sorghum.loopra.bin.builtin;

import org.noear.snack4.Feature;
import org.noear.snack4.ONode;
import org.noear.snack4.Options;
import org.noear.snack4.json.JsonWriter;
import org.noear.solon.annotation.Component;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * 子代理角色配置仓库：{@code ~/.loopra/sub-agents.json} 为权威存储。
 * <p>首次访问时自动生成默认配置文件（内置 5 个角色，全部启用），之后以文件为准：
 * 用户可直接修改 name / description / instructions / allowedTools / readOnly，
 * 或把 enable 改为 false 禁用该角色；角色 id 是稳定标识，不会重复持久化。</p>
 * <p>文件缺失或损坏时回退到内置默认（不覆盖用户文件），不影响子代理功能。
 * 每次读取实时加载文件，修改后无需重启立即生效。</p>
 * <p>示例配置：</p>
 * <pre>{@code
 * {
 *   "profiles": [
 *     {
 *       "id": "explore",
 *       "name": "探索",
 *       "description": "定位代码、追溯调用链并基于证据汇报",
 *       "enable": true,
 *       "readOnly": true,
 *       "instructions": "你是探索子代理。...",
 *       "allowedTools": ["workspace_read"]
 *     }
 *   ]
 * }
 * }</pre>
 */
@Component
public class SubAgentProfileStore {

    private static final Logger log = LoggerFactory.getLogger(SubAgentProfileStore.class);
    private static final String CONFIG_FILE = "sub-agents.json";
    /** 首次访问是否已执行过内置合并（只合并一次，防止重复写盘） */
    private volatile boolean builtinMerged = false;

    /** 内置默认角色（作为首次生成配置文件的模板，不参与运行期合并） */
    public static List<SubAgentProfileConfig> defaults() {
        List<SubAgentProfileConfig> list = new ArrayList<>();
        for (SubAgentProfile profile : SubAgentProfile.values()) {
            SubAgentProfileConfig config = new SubAgentProfileConfig();
            config.id = profile.id();
            config.name = profile.displayName();
            config.description = profile.description();
            config.enable = true;
            config.readOnly = profile.readOnly();
            config.instructions = profile.instructions();
            list.add(config);
        }
        return list;
    }

    /** 内置角色（Java 定义为准）与配置文件合并：内容字段强制用内置值，enable 保留用户设置 */
    private void mergeBuiltins(List<SubAgentProfileConfig> profiles) {
        for (SubAgentProfile profile : SubAgentProfile.values()) {
            SubAgentProfileConfig config = profiles.stream()
                    .filter(c -> c.id != null && c.id.trim().equalsIgnoreCase(profile.id()))
                    .findFirst()
                    .orElse(null);
            if (config == null) {
                config = new SubAgentProfileConfig();
                config.id = profile.id();
                config.enable = true;
                profiles.add(config);
            }
            // 内容字段以内置定义为准；enable 保留用户设置
            config.name = profile.displayName();
            config.description = profile.description();
            config.readOnly = profile.readOnly();
            config.instructions = profile.instructions();
            config.allowedTools = null;
        }
        try {
            save(profiles);
        } catch (Exception e) {
            log.warn("合并内置子代理定义后写盘失败，本次使用内存结果: {}", e.getMessage());
        }
    }

    /** 判断 id 是否为内置角色（大小写不敏感） */
    public static boolean isBuiltin(String id) {
        if (id == null) {
            return false;
        }
        for (SubAgentProfile profile : SubAgentProfile.values()) {
            if (profile.id().equalsIgnoreCase(id.trim())) {
                return true;
            }
        }
        return false;
    }

    /** 已启用的全部角色（以配置文件为权威；首次调用会生成默认配置文件） */
    public List<SubAgentProfileConfig> all() {
        return allIncludingDisabled().stream()
                .filter(SubAgentProfileConfig::enabled)
                .collect(Collectors.toList());
    }

    /** 全部角色（含已禁用），供前端展示/编辑，以便重新启用 */
    public List<SubAgentProfileConfig> allIncludingDisabled() {
        SubAgentConfigFile file = loadOrCreateFile();
        List<SubAgentProfileConfig> profiles = file != null ? file.profiles : null;
        if (profiles == null) {
            return defaults();
        }
        if (!builtinMerged) {
            builtinMerged = true;
            mergeBuiltins(profiles);
        }
        return profiles.stream()
                .filter(config -> config.id != null && !config.id.isBlank())
                .collect(Collectors.toList());
    }

    /**
     * 全量保存角色配置到文件。id 必填且不可重复；allowedTools 空列表会归一化为 null（自动模式）。
     */
    public void save(List<SubAgentProfileConfig> profiles) {
        if (profiles == null) {
            throw new IllegalArgumentException("子代理角色列表不能为空");
        }
        Set<String> seen = new HashSet<>();
        for (SubAgentProfileConfig config : profiles) {
            if (config.id == null || config.id.isBlank()) {
                throw new IllegalArgumentException("子代理角色 id 不能为空");
            }
            String normalizedId = config.id.trim().toLowerCase(Locale.ROOT);
            if (!seen.add(normalizedId)) {
                throw new IllegalArgumentException("子代理角色 id 重复: " + normalizedId);
            }
            config.id = normalizedId;
            if (config.allowedTools != null) {
                config.allowedTools = config.allowedTools.stream()
                        .map(tool -> tool == null ? null : tool.trim())
                        .filter(tool -> tool != null && !tool.isEmpty())
                        .collect(Collectors.toList());
                if (config.allowedTools.isEmpty()) {
                    config.allowedTools = null;
                }
            }
        }
        try {
            Path path = configPath();
            Files.createDirectories(path.getParent());
            SubAgentConfigFile data = new SubAgentConfigFile();
            data.profiles = profiles;
            String json = JsonWriter.write(
                    ONode.ofBean(data),
                    Options.of(Feature.Write_PrettyFormat));
            Files.writeString(path, json, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException("保存子代理配置失败: " + e.getMessage(), e);
        }
    }

    /** 按 id 查找已启用角色；未知/已禁用角色抛出与历史一致的异常 */
    public SubAgentProfileConfig from(String value) {
        List<SubAgentProfileConfig> profiles = all();
        if (value != null) {
            String normalized = value.trim().toLowerCase(Locale.ROOT);
            for (SubAgentProfileConfig config : profiles) {
                if (config.id.equals(normalized)) {
                    return config;
                }
            }
        }
        String available = profiles.stream().map(c -> c.id).collect(Collectors.joining(", "));
        throw new IllegalArgumentException("未知子代理角色: " + value + "。可用角色: " + available);
    }

    private SubAgentConfigFile loadOrCreateFile() {
        Path path = configPath();
        if (!Files.exists(path)) {
            return createDefaultFile(path);
        }
        try {
            String json = Files.readString(path, StandardCharsets.UTF_8);
            SubAgentConfigFile file = ONode.ofJson(json).toBean(SubAgentConfigFile.class);
            if (file == null || file.profiles == null) {
                log.warn("子代理配置文件缺少 profiles 字段，回退内置默认: {}", path);
                return null;
            }
            return file;
        } catch (IOException e) {
            log.warn("读取子代理配置失败，回退内置默认: {}", path, e);
            return null;
        } catch (RuntimeException e) {
            log.warn("解析子代理配置失败，回退内置默认: {}", path, e);
            return null;
        }
    }

    private SubAgentConfigFile createDefaultFile(Path path) {
        try {
            Files.createDirectories(path.getParent());
            SubAgentConfigFile data = new SubAgentConfigFile();
            data.profiles = defaults();
            String json = JsonWriter.write(
                    ONode.ofBean(data),
                    Options.of(Feature.Write_PrettyFormat));
            Files.writeString(path, json, StandardCharsets.UTF_8);
            log.info("已生成默认子代理配置文件: {}", path);
            return data;
        } catch (IOException e) {
            log.warn("生成默认子代理配置失败，使用内置默认: {}", path, e);
            return null;
        }
    }

    private Path configPath() {
        return Paths.get(System.getProperty("user.home"), ".loopra", CONFIG_FILE);
    }

    /** 持久化数据结构：子代理角色列表 */
    public static class SubAgentConfigFile {
        public List<SubAgentProfileConfig> profiles;
    }
}
