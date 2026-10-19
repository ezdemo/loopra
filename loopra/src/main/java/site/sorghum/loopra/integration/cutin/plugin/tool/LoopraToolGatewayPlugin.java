package site.sorghum.loopra.integration.cutin.plugin.tool;

import lombok.extern.slf4j.Slf4j;
import org.noear.solon.ai.chat.tool.FunctionTool;
import site.sorghum.cutin.core.plugin.AgentPlugin;
import site.sorghum.cutin.core.plugin.LoopPlugin;
import site.sorghum.cutin.core.plugin.LoopRegistrar;
import site.sorghum.cutin.core.plugin.PluginContext;
import site.sorghum.loopra.bin.agent.environment.SessionEnvironment;
import site.sorghum.loopra.bin.tool.ToolScanUtil;
import site.sorghum.loopra.bin.tool.ToolRegistry;
import site.sorghum.loopra.integration.cutin.CutinFunctionToolBridge;
import site.sorghum.loopra.tool.solon.common.LoopraSkillProvider;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * 工具网关插件 —— 把原来 {@code ToolSystemInitializer + ToolScanUtil + LoopraSkillProvider}
 * 分散在 3 处的工具扫描收敛到一个 cutin 插件。
 * <p>
 * 职责：
 * <ul>
 *   <li>通过 {@link ToolScanUtil#scanTools}（Solon Bean + File Skill）发现全部 FunctionTool</li>
 *   <li>经 {@link CutinFunctionToolBridge} 转为 cutin {@code Tool} 并注册到 {@code LoopRegistrar}</li>
 *   <li>热卸载时 {@link site.sorghum.cutin.core.plugin.Registration#close()} 自动注销全部工具</li>
 * </ul>
 * 禁用本插件即下线全部工具，外部插件可独立注册 {@code ToolProvider} 与本插件并存。
 * </p>
 */
@Slf4j
@AgentPlugin(id = "loopra-tool-gateway", order = -900, remark = "Solon/Skill 工具扫描与注册网关")
public final class LoopraToolGatewayPlugin implements LoopPlugin {

    private LoopraToolHost host;

    public LoopraToolGatewayPlugin() {}

    public LoopraToolGatewayPlugin(LoopraToolHost host) {
        this.host = host;
    }

    @Override
    public String id() {
        return "loopra-tool-gateway";
    }

    @Override
    public void configure(PluginContext context) {
        if (host == null) {
            try {
                host = context.getBean(LoopraToolHost.class);
            } catch (Exception ignored) {
                // Host Bean 未注册时保持 null
            }
        }
    }

    @Override
    public void register(LoopRegistrar registrar) {
        Path workspace = null;
        ToolRegistry legacyRegistry = null;
        if (host != null) {
            SessionEnvironment env = host.environment();
            if (env != null) workspace = env.executionRoot();
            legacyRegistry = host.toolRegistry();
        }

        List<FunctionTool> discovered = new ArrayList<>();
        // 优先使用 legacy registry 已有的工具（保持与旧刷新逻辑一致），否则回退到扫描
        if (legacyRegistry != null && !legacyRegistry.all().isEmpty()) {
            discovered.addAll(legacyRegistry.all().values());
            // 补充扫描可能遗漏的文件技能（未在 legacy 中的）
            try {
                for (FunctionTool t : ToolScanUtil.scanTools(workspace)) {
                    if (!legacyRegistry.all().containsKey(t.name())) {
                        discovered.add(t);
                    }
                }
            } catch (Exception e) {
                log.debug("[tool-gateway] supplemental scan failed: {}", e.getMessage());
            }
        } else {
            try {
                discovered.addAll(ToolScanUtil.scanTools(workspace));
            } catch (Exception e) {
                log.warn("[tool-gateway] scanTools failed: {}", e.getMessage(), e);
            }
        }

        if (legacyRegistry != null && legacyRegistry.isSessionMcpManaged()) {
            discovered.removeIf(tool -> tool instanceof site.sorghum.loopra.tool.solon.mcp.McpFunctionTool);
            discovered.addAll(0, legacyRegistry.sessionTools());
        }

        // 去重：同名工具保留首次发现
        java.util.Map<String, FunctionTool> dedup = new java.util.LinkedHashMap<>();
        for (FunctionTool t : discovered) {
            dedup.putIfAbsent(t.name(), t);
        }

        int registered = 0;
        int skippedDisabled = 0;
        for (FunctionTool tool : dedup.values()) {
            // 尊重禁用列表（热插拔：disabled 工具不在 cutin 中注册）
            if (legacyRegistry != null && !legacyRegistry.isEnabled(tool.name())) {
                skippedDisabled++;
                continue;
            }
            // 同步写入 legacy registry（供 AgentLoop 旧路径如 StormBreaker 过滤使用）
            if (legacyRegistry != null) {
                try {
                    if (!legacyRegistry.all().containsKey(tool.name())) {
                        legacyRegistry.register(tool);
                    }
                } catch (Exception ex) {
                    log.debug("[tool-gateway] legacy register skip {}: {}", tool.name(), ex.getMessage());
                }
            }
            try {
                registrar.registerTool(new CutinFunctionToolBridge(tool));
                registered++;
            } catch (Exception ex) {
                log.warn("[tool-gateway] register cutin tool {} failed: {}", tool.name(), ex.getMessage());
            }
        }
        log.info("[tool-gateway] 已注册 {} 个工具 (workspace={}, dedup={}, skippedDisabled={})", registered, workspace, dedup.size(), skippedDisabled);

        // 暴露技能刷新钩子：宿主可通过 host 触发重新扫描（保留兼容）
        if (host != null) {
            // 将 skill provider 的系统提示词能力委托给 Prompt 插件，这里仅保证热刷新后工具可重建
            // 外部文件 skill 变化可通过重新 start 插件完成热重载
        }
    }

    /** 工具宿主，供插件拿到环境与 legacy 注册表。 */
    public interface LoopraToolHost {
        SessionEnvironment environment();
        ToolRegistry toolRegistry();
        default Path workspace() {
            SessionEnvironment env = environment();
            return env == null ? null : env.executionRoot();
        }
    }
}
