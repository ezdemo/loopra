package site.sorghum.loopra.bin.builtin;

import lombok.extern.slf4j.Slf4j;
import org.noear.solon.ai.annotation.ToolMapping;
import org.noear.solon.ai.chat.tool.AbsToolProvider;
import org.noear.solon.ai.chat.tool.FunctionTool;
import org.noear.solon.annotation.Component;
import org.noear.solon.annotation.Inject;
import org.noear.solon.annotation.Param;
import site.sorghum.loopra.bin.agent.core.SubAgent;
import site.sorghum.loopra.bin.agent.output.SubAgentEventRecorder;
import site.sorghum.loopra.bin.agent.spi.AgentConfig;
import site.sorghum.loopra.bin.config.LoopraConfig;
import site.sorghum.loopra.bin.model.LoopraModelProvider;
import site.sorghum.loopra.bin.project.ProjectRegistry;
import site.sorghum.loopra.bin.session.SubAgentSessionManager;
import site.sorghum.loopra.bin.session.SubAgentSessionStore;
import site.sorghum.loopra.bin.tool.ToolMetadata;
import site.sorghum.loopra.bin.tool.ToolRegistry;
import site.sorghum.loopra.tool.AgentLoopController;
import site.sorghum.loopra.tool.SolonToTools;
import site.sorghum.loopra.tool.ToolContext;

import java.io.IOException;
import java.nio.file.Path;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.UUID;

/**
 * SubAgent 工具 —— 创建具有预设角色的隔离子代理。
 * <p>
 * 使用 {@link SubAgent} 继承父工具集，排除递归 spawn 和用户交互工具。
 * </p>
 *
 * @author Sorghum
 */
@Slf4j
@Component
public class SubAgentTool extends AbsToolProvider implements SolonToTools {

    @Inject
    private LoopraModelProvider modelProvider;

    @Inject
    private SubAgentProfileStore profileStore;

    @Inject
    private LoopraConfig loopraConfig;

    @Inject
    private SubAgentSessionManager subAgentSessionManager;

    @ToolMapping(name = "sub_agent", description = """
                 派生一个带预设角色的隔离子代理，完成后将结果返回给主代理。
                  可用角色: explore（只读项目探索）, implement（实现）, test（测试）, review（只读项目审查）, plan（只读项目方案）。
                  参数: name(必传), profile(必传), task(必传), instructions(可选)。
                  name 为子代理的名字，支持人名/二次元名字等（如：张三、初音未来），将作为会话名称前缀与角色称呼。
                  注意：explore/review/plan 只能使用只读项目工具；`workspace_write` 仅用于主代理与子代理之间的协作通信；子代理不可再创建子代理。
                """)
    public String subAgent(@Param(name = "name", description = "子代理名字，支持人名/二次元名字等（如：张三、初音未来），作为会话名称前缀与角色称呼，必传") String name,
                           @Param(name = "profile", description = "子代理角色: explore / implement / test / review / plan") String profile,
                           @Param(name = "task", description = "需要子代理完成的具体任务（会话名称取 name + 任务首句）") String task,
                           @Param(name = "instructions", description = "可选的补充要求，不会覆盖角色约束", required = false) String instructions,
                           @Param(name = "ctx", required = false) ToolContext ctx) {
        if (name == null || name.isBlank()) {
            return "INVALID_SUB_AGENT_NAME: name 不能为空（支持人名/二次元名字等，如：张三、初音未来）";
        }
        if (task == null || task.isBlank()) {
            return "INVALID_SUB_AGENT_TASK: task 不能为空";
        }
        final SubAgentProfileConfig selectedProfile;
        try {
            selectedProfile = profileStore.from(profile);
        } catch (IllegalArgumentException e) {
            return "INVALID_SUB_AGENT_PROFILE: " + e.getMessage();
        }
        try {
            // 检查父级是否已请求中断（通过 AgentLoopController 传播的 ThreadLocal）
            if (ctx.getLoopController() != null && ctx.getLoopController().isAbortRequested()) {
                return "⏹️ 用户已中断，跳过子代理执行";
            }

            ToolRegistry registry = ctx.getLoopController().getToolRegistry();
            AgentLoopController parentController = ctx.getLoopController();
            Set<String> allowedTools = selectedProfile.allowedTools(registry.all().values());

            // 计划模式继承：父代理处于计划模式时，子代理工具强制收敛为只读集合
            // （同时影响子代理系统提示词的工具规范列举与子循环的冻结工具列表）
            if (parentController != null && parentController.isPlanMode()) {
                Set<String> readOnlyNames = new LinkedHashSet<>();
                for (FunctionTool def : registry.all().values()) {
                    if (ToolMetadata.isReadOnly(def)) {
                        readOnlyNames.add(def.name());
                    }
                }
                if (allowedTools == null) {
                    allowedTools = readOnlyNames;
                } else {
                    allowedTools.retainAll(readOnlyNames);
                }
            }

            StringBuilder systemPromptBuilder = new StringBuilder(
                    "## 角色设定\n\n你的名字是「" + name.trim() + "」，请以该身份与用户协作，并在需要自我介绍时使用这个名字。\n\n"
                            + selectedProfile.buildSystemPrompt(task, instructions));
            if (registry.getEnvironment() != null
                    && registry.getEnvironment().executionRoot() != null) {
                systemPromptBuilder.append("\n\n## 运行环境\n\n工作目录: `")
                        .append(registry.getEnvironment().executionRoot().toAbsolutePath().normalize())
                        .append('`');
            }
            systemPromptBuilder.append("\n\n## 可用工具规范\n\n");
            for (FunctionTool def : registry.all().values()) {
                if (!SubAgent.SUB_AGENT_DENY.contains(def.name())
                        && (allowedTools == null || allowedTools.contains(def.name()))) {
                    String spec = def.descriptionAndMeta();
                    if (spec != null && !spec.isEmpty()) {
                        systemPromptBuilder.append(spec).append("\n\n---\n\n");
                    }
                }
            }
            boolean terminateOnNoToolCall = parentController == null
                    || parentController.terminateOnNoToolCall();
            systemPromptBuilder.append(terminateOnNoToolCall
                    ? "无工具调用时，模型的纯文本回复会结束对话。"
                    : "结束对话必须调用 `finish`，纯文本回复不会退出循环。");
            String systemPrompt = systemPromptBuilder.toString();

            // 获取父级 AgentLoopController，传播中断信号到子代理
            LoopraModelProvider parentProvider = parentController != null ? parentController.getModelProvider() : null;
            LoopraModelProvider sourceProvider = parentProvider != null ? parentProvider : modelProvider;
            SubAgent sub = new SubAgent(resolveSubProvider(selectedProfile, sourceProvider), registry, systemPrompt, parentController);
            sub.setAllowedTools(allowedTools);
            // 会话名称 = name + 任务首句（多轮续写保持稳定，sub_start 事件与回放列表均以此命名）；
            // name/title 单独落盘：会话列表按「名字 + 标题」展示
            String title = buildTitle(task);
            String cleanName = name.trim();
            sub.setAgentName(cleanName);
            sub.setSessionTitle(title);
            sub.setSessionName(cleanName + "：" + title);

            if (parentController != null) {
                parentController.registerToolCancellation(sub::abort);
            }

            try {
                String parentSessionId = ctx.getSessionId();
                if (parentSessionId != null) {
                    sub.setSessionId(parentSessionId);
                }
                // 子代理会话持久化：挂在父会话名下（父子级），仅当有父会话且能定位项目会话目录时启用
                if (parentSessionId != null && ctx.getRootDir() != null) {
                    try {
                        Path sessionsDir = new ProjectRegistry().getSessionsDir(ctx.getRootDir().toString());
                        String subSessionId = "sub-" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
                        sub.setRecorder(new SubAgentEventRecorder(
                                new SubAgentSessionStore(sessionsDir), parentSessionId, subSessionId));
                        // 登记活跃子代理：执行结束后用户仍可在回放标签里继续对话（进程内有效）
                        subAgentSessionManager.register(subSessionId, sub);
                    } catch (Exception e) {
                        log.warn("[sub] 初始化子代理会话记录失败: {}", e.getMessage());
                    }
                }
                String result = sub.run(task, new SubAgentListener());
                return result;
            } finally {
                if (parentController != null) {
                    parentController.clearToolCancellation();
                }
            }
        } catch (IOException e) {
            return "IO_ERROR: " + e.getMessage();
        }
    }

    /**
     * 生成会话标题：任务首句（换行/句号/问号/感叹号处断句，超长截断）。
     * 首句取自用户的第一条任务描述，后续轮次继续对话时标题保持不变。
     */
    private static String buildTitle(String task) {
        String t = task.trim();
        String first = t;
        for (char c : t.toCharArray()) {
            if (c == '\n' || c == '。' || c == '！' || c == '？' || c == '!' || c == '?') {
                int idx = t.indexOf(c);
                first = t.substring(0, idx + 1).trim();
                break;
            }
        }
        if (first.length() > 60) {
            first = first.substring(0, 60) + "…";
        }
        return first;
    }

    /**
     * 解析子代理的模型 Provider：角色配置了独立渠道时按渠道创建，否则继承父级渠道。
     */
    private LoopraModelProvider resolveSubProvider(SubAgentProfileConfig profile, LoopraModelProvider fallback) {
        if (profile.modelChannel == null || profile.modelChannel.isBlank()) {
            return fallback.fork();
        }
        LoopraConfig.ModelChannel channel = loopraConfig.modelChannel(profile.modelChannel);
        if (channel == null) {
            log.warn("子代理 {} 配置的模型渠道不存在: {}，回退继承父级渠道", profile.id(), profile.modelChannel);
            return fallback.fork();
        }
        String model = profile.model != null && !profile.model.isBlank()
                ? profile.model
                : (channel.modelEntries().isEmpty() ? loopraConfig.model() : channel.modelEntries().get(0).name());
        LoopraConfig.ModelEntry entry = channel.modelEntry(model);
        int maxTokens = entry != null && entry.maxTokens() > 0
                ? entry.maxTokens() : AgentConfig.DEFAULT_MAX_TOKENS;
        // 注意：必须使用 apiUrl()（按协议补全 /chat/completions 或 /responses 后缀），
        // 直接传 baseUrl() 会把请求发到裸地址（如 POST /v1），网关会返回 404 Invalid URL。
        return new LoopraModelProvider(channel.apiUrl(), channel.apiKey(), model,
                loopraConfig.reasoningEffort(), channel.id(), channel.apiProtocol(), channel.specialCompatibility(), maxTokens);
    }
    @Override
    public Collection<FunctionTool> getSolonTools() {
        return this.getTools();
    }
}
