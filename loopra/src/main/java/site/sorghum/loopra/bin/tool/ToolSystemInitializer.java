package site.sorghum.loopra.bin.tool;

import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.ONode;
import site.sorghum.loopra.bin.agent.environment.SessionEnvironment;
import site.sorghum.loopra.bin.agent.prompt.PromptPrefix;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;

/**
 * 工具系统初始化器 —— 插件化后仅创建空注册表，其余由 cutin 插件热插拔。
 */
@Slf4j
public final class ToolSystemInitializer {

    private ToolSystemInitializer() {
    }

    private static final int MAX_PROJECT_DOC_BYTES = 256 * 1024;

    private static final List<String> PROJECT_RULE_NAMES = List.of(
            "loopra.md",
            "claude.md",
            "agents.md",
            "agent.md"
    );

    /**
     * 插件化初始化：不再扫描工具与拼接提示词。
     * 真实 system 由 {@code LoopraPromptPlugin} 切片组装，工具由 {@code LoopraToolGatewayPlugin} 注册。
     */
    public static ToolSystem initialize(SessionEnvironment environment, Set<String> disabledTools,
                                    String defaultSystemPrompt) {
        return initializePluginized(environment, disabledTools);
    }

    public static ToolSystem initializePluginized(SessionEnvironment environment, Set<String> disabledTools) {
        final ToolRegistry registry = createRegistry(environment, disabledTools);
        // 空前缀：真实 system 在 BEFORE_MODEL 由 LoopraPromptPlugin 注入，可热插拔/禁用
        ONode emptyTools = ONode.ofJson("[]").asArray();
        PromptPrefix prefix = new PromptPrefix("", emptyTools);
        log.info("[init] 工具系统初始化完成（插件化） — 初始工具数: 0, workspace={}",
                environment == null ? null : environment.executionRoot());
        return new ToolSystem(registry, prefix);
    }

    /**
     * 兼容旧路径：保留完整扫描与拼接，仅测试/回归使用。
     */
    public static ToolSystem initializeLegacy(SessionEnvironment environment, Set<String> disabledTools,
                                    String defaultSystemPrompt) {
        Path workspace = environment == null ? null : environment.executionRoot();
        final ToolRegistry registry = createRegistry(environment, disabledTools);
        List<org.noear.solon.ai.chat.tool.FunctionTool> agentTools = ToolScanUtil.scanTools(workspace);
        StringBuilder toolSpecsBuilder = new StringBuilder();
        toolSpecsBuilder.append("\n\n## 可用工具规范\n\n");
        for (org.noear.solon.ai.chat.tool.FunctionTool tool : agentTools) {
            String toolSpec = tool.descriptionAndMeta();
            if (toolSpec != null && !toolSpec.isEmpty()) {
                toolSpecsBuilder.append(toolSpec).append("\n\n---\n\n");
            }
        }
        String systemPrompt = defaultSystemPrompt;
        systemPrompt = systemPrompt + "\n\n" + ToolScanUtil.getSkillToolDescription(workspace);
        systemPrompt = systemPrompt + "\n\n";
        systemPrompt = systemPrompt + "\n\n---\n\n" + site.sorghum.loopra.bin.agent.prompt.EnvInfoUtil.buildEnvInfo(workspace);
        String projectMd = loadProjectMd(workspace);
        if (!projectMd.isEmpty()) {
            systemPrompt = systemPrompt + "\n\n---\n\n" + projectMd;
        }
        PromptPrefix prefix = new PromptPrefix(systemPrompt, registry.toOpenAiTools());
        log.info("[init] 工具系统初始化完成 — 工具数: {}", agentTools.size());
        return new ToolSystem(registry, prefix);
    }

    private static ToolRegistry createRegistry(SessionEnvironment environment, Set<String> disabledTools) {
        final Set<String> effectiveDisabledTools = disabledTools != null ? disabledTools : Collections.emptySet();
        final ToolRegistry registry = new ToolRegistry();
        registry.setDisabledTools(effectiveDisabledTools);
        registry.setEnvironment(environment);
        if (!effectiveDisabledTools.isEmpty()) {
            log.info("[config] 已禁用工具: {}", String.join(", ", effectiveDisabledTools));
        }
        return registry;
    }

    public static String loadProjectMd(Path workspace) {
        if (workspace == null || !Files.isDirectory(workspace)) {
            return "";
        }

        Map<String, Path> matched = new LinkedHashMap<>();
        try (Stream<Path> entries = Files.list(workspace)) {
            for (Path file : entries.toList()) {
                if (!Files.isRegularFile(file)) continue;
                Path fileName = file.getFileName();
                if (fileName == null) continue;
                String canonicalName = fileName.toString().toLowerCase();
                if (PROJECT_RULE_NAMES.contains(canonicalName)) {
                    matched.putIfAbsent(canonicalName, file);
                }
            }
        } catch (IOException e) {
            log.warn("[init] 读取项目根目录失败: {}", e.getMessage());
            return "";
        }

        StringBuilder sb = new StringBuilder();
        for (String name : PROJECT_RULE_NAMES) {
            Path file = matched.get(name);
            if (file == null) continue;
            try {
                if (Files.size(file) > MAX_PROJECT_DOC_BYTES) {
                    log.warn("[init] 跳过过大的项目规则文件: {} ({} bytes)", file, Files.size(file));
                    continue;
                }
                String content = Files.readString(file).trim();
                if (content.isEmpty()) continue;
                if (sb.length() > 0) {
                    sb.append("\n\n");
                }
                sb.append("## ").append(file.getFileName()).append("\n\n").append(content);
            } catch (IOException e) {
                log.warn("[init] 读取项目规则文件失败: {} - {}", file, e.getMessage());
            }
        }
        return sb.toString();
    }

    public record ToolSystem(ToolRegistry toolRegistry, PromptPrefix promptPrefix) {
    }
}
