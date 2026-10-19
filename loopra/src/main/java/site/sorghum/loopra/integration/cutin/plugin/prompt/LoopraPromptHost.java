package site.sorghum.loopra.integration.cutin.plugin.prompt;

import site.sorghum.loopra.bin.agent.environment.SessionEnvironment;
import site.sorghum.loopra.bin.tool.ToolRegistry;

import java.nio.file.Path;

/**
 * Prompt 插件依赖的宿主能力。
 * <p>
 * 由 {@code AgentLoop} 实现，插件通过 {@code PluginContext.getBean(LoopraPromptHost.class)}
 * 拿到环境与工具信息，避免直接依赖 AgentLoop。
 * </p>
 */
public interface LoopraPromptHost {

    SessionEnvironment environment();

    default Path workspace() {
        SessionEnvironment env = environment();
        if (env == null || env.executionRoot() == null) return null;
        return env.executionRoot();
    }

    ToolRegistry toolRegistry();

    PromptRegistry promptRegistry();

    /**
     * 声明式 system 前缀 —— 子代理自拼 system 时由宿主提供，主循环返回空串。
     * <p>
     * 供 {@code LoopraPromptPlugin} 识别「已有 system 是不是本宿主提供的」，
     * 取代按提示词正文嗅探（正文一改就失效）。
     * </p>
     */
    default String systemPrefix() {
        return "";
    }

    /**
     * 工具协作约定的动态尾部（Goal 指令、Plan Mode 指令等）。
     *
     * @deprecated 易变状态不再进入 system —— Goal 与计划模式改由
     *             {@code LoopraStateNoticePlugin} 以历史中的状态通知注入
     *             （见 {@code StateNoticeRenderer}）。保留此默认方法只为兼容
     *             未同步升级的外置插件，实现方应直接忽略它。
     */
    @Deprecated(since = "26.9.91", forRemoval = true)
    default String dynamicToolContractTail() {
        return "";
    }
}
