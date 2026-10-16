package site.sorghum.loopra.integration.cutin.plugin.prompt;

import lombok.extern.slf4j.Slf4j;
import site.sorghum.cutin.core.context.LoopContext;
import site.sorghum.cutin.core.context.Message;
import site.sorghum.cutin.core.loop.InterceptContext;
import site.sorghum.cutin.core.loop.InterceptDecision;
import site.sorghum.cutin.core.loop.InterceptPoint;
import site.sorghum.cutin.core.model.ModelCallRequest;
import site.sorghum.cutin.core.plugin.AgentPlugin;
import site.sorghum.cutin.core.plugin.LoopPlugin;
import site.sorghum.cutin.core.plugin.LoopRegistrar;
import site.sorghum.cutin.core.plugin.PluginContext;
import site.sorghum.loopra.bin.agent.prompt.ClaudeCodePrompt;
import site.sorghum.loopra.bin.agent.prompt.DEFAULT_PROMPT;
import site.sorghum.loopra.bin.agent.prompt.EnvInfoUtil;
import site.sorghum.loopra.bin.tool.ToolSystemInitializer;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;

/**
 * 系统提示词聚合插件 —— 把原来 {@link ToolSystemInitializer} 里的
 * 静态拼串 5 段改为切片，在 {@code BEFORE_MODEL} 动态注入。
 */
@Slf4j
@AgentPlugin(id = "loopra-prompt", order = -1000, remark = "系统提示词动态聚合与注入")
public final class LoopraPromptPlugin implements LoopPlugin {

    private LoopraPromptHost host;
    private PromptRegistry registry;
    private final List<PromptSliceProvider> builtIns = new ArrayList<>();

    public LoopraPromptPlugin() {}

    public LoopraPromptPlugin(LoopraPromptHost host, PromptRegistry registry) {
        this.host = host;
        this.registry = registry;
    }

    @Override
    public String id() {
        return "loopra-prompt";
    }

    @Override
    public void configure(PluginContext context) {
        if (host == null) {
            try {
                host = context.getBean(LoopraPromptHost.class);
            } catch (Exception ignored) {
                // Host Bean 未注册时保持 null，后续按默认行为处理
            }
        }
        if (registry == null) {
            try {
                registry = context.getBean(PromptRegistry.class);
            } catch (Exception e) {
                registry = new PromptRegistry();
            }
        }
        if (builtIns.isEmpty()) {
            registerBuiltIns();
        } else {
            // 重启场景：stop() 已注销内置切片，此处幂等补注册，避免重复 add 到 builtIns
            for (PromptSliceProvider p : builtIns) {
                if (registry != null) registry.register(p);
            }
        }
    }

    @Override
    public void register(LoopRegistrar registrar) {
        // 900 晚于 Compaction(-200)/ModelPolicy(-100)，避免被 context.replace 覆盖；
        // 确保最终 system 为切片聚合结果
        registrar.registerInterceptor(InterceptPoint.BEFORE_MODEL, 900, this::inject);
    }

    @Override
    public void stop() {
        if (registry != null && !builtIns.isEmpty()) {
            for (PromptSliceProvider p : builtIns) {
                registry.unregister(p);
            }
        }
        // 禁用后 registry.assemble 将为空，拦截器已注销，后续 ModelCallRequest 不再注入
    }

    private void registerBuiltIns() {
        // 核心身份：Claude Code 原文移植版（逐字，仅换工具名）
        PromptSliceProvider core = ctx -> PromptSlice.of("core-identity", ClaudeCodePrompt.join(), 100);
        // Loopra 特有补充：Claude Code 原文里没有的能力（workspace_* / browser_* / goal_* 等）
        PromptSliceProvider supplement = ctx -> PromptSlice.of("loopra-supplement", DEFAULT_PROMPT.PROMPT, 150);
        // 语言约束：用 Claude Code 自己的 getLanguageSection 措辞，英文原文不必改动
        PromptSliceProvider language = ctx -> PromptSlice.of("language", """
                # Language
                Always respond in Chinese (Simplified). Use Chinese (Simplified) for all explanations, comments, and communications with the user. Technical terms and code identifiers should remain in their original form.""", 250);
        // 用户级 ~/.loopra/loopra.md：旧路径由 AgentService.loadDefaultSystemPrompt 拼在 core 之后，
        // 插件化后由本切片补齐，保证设置页保存的「系统提示词」仍然生效。
        PromptSliceProvider userPrompt = ctx -> {
            Path homePrompt = Paths.get(System.getProperty("user.home"), ".loopra", "loopra.md");
            if (!Files.isRegularFile(homePrompt)) return null;
            try {
                String content = Files.readString(homePrompt);
                if (content == null || content.isBlank()) return null;
                return PromptSlice.of("user-prompt", content.trim(), 200);
            } catch (Exception e) {
                log.debug("[prompt] 读取用户级 ~/.loopra/loopra.md 失败: {}", e.getMessage());
                return null;
            }
        };
        PromptSliceProvider skill = ctx -> {
            // 与旧路径 SolonToolScanProvider.getSkillToolDescription 完全一致：
            // LoopraSkillProvider 系统提示 + Solon context 中全部 SolonToTools bean 的提示
            Path ws = host == null ? null : host.workspace();
            String skillPrompt = "";
            try {
                skillPrompt = site.sorghum.loopra.bin.tool.ToolScanUtil.getSkillToolDescription(ws);
            } catch (Exception e) {
                log.debug("[prompt] skill prompt load failed: {}", e.getMessage());
            }
            if (skillPrompt == null || skillPrompt.isBlank()) return null;
            return PromptSlice.of("skill-contract", skillPrompt.trim(), 300);
        };
        PromptSliceProvider env = ctx -> {
            Path ws = host == null ? null : host.workspace();
            String v = EnvInfoUtil.buildEnvInfo(ws);
            return PromptSlice.of("env-info", v, 500);
        };
        PromptSliceProvider toolContract = ctx -> {
            // 工具协作约定：原来在 AgentLoop.prepareMessages 中每轮拼到 system 的动态尾部，现收敛为切片；
            // 静态文案与 AgentLoop.buildToolInstructions 共用 ToolContract 单一来源。
            // Goal / 计划模式等易变状态不再拼进这里（那会让 system 每轮变字节、前缀缓存全废），
            // 改由 LoopraStateNoticePlugin 作为历史中的状态通知注入。
            boolean terminate = false;
            try {
                if (host instanceof site.sorghum.loopra.bin.agent.core.AgentLoop al) {
                    terminate = al.terminateOnNoToolCall();
                }
            } catch (Exception ignored) {
                // 方法不可用时按 false 处理
            }
            return PromptSlice.of("tool-contract", ToolContract.build(terminate, ""), 600);
        };
        PromptSliceProvider planContract = ctx -> {
            // 计划模式的静态不变量常驻 system：只读约束不随模式切换变化，
            // 即使状态通知被折叠或被插件禁用，模型仍知道约束存在。
            return PromptSlice.of("plan-contract",
                    site.sorghum.loopra.bin.agent.prompt.PlanModeContract.TEXT, 650);
        };
        PromptSliceProvider doc = ctx -> {
            Path ws = host == null ? null : host.workspace();
            String d = ToolSystemInitializer.loadProjectMd(ws);
            if (d == null || d.isBlank()) return null;
            return PromptSlice.of("project-doc", d.trim(), 900);
        };
        builtIns.add(core);
        builtIns.add(supplement);
        builtIns.add(userPrompt);
        builtIns.add(language);
        builtIns.add(skill);
        builtIns.add(env);
        builtIns.add(toolContract);
        builtIns.add(planContract);
        builtIns.add(doc);
        for (PromptSliceProvider p : builtIns) registry.register(p);
    }

    private InterceptDecision inject(InterceptContext intercept) {
        Object payload = intercept.payload();
        if (!(payload instanceof ModelCallRequest request)) {
            return InterceptDecision.pass();
        }
        LoopContext context = intercept.context();
        // assembleOnce：与折叠插件（order -200）共享同一次装配结果，避免重复读盘
        String built = registry != null ? registry.assembleOnce(context) : "";
        if (built == null) built = "";
        String existingSystem = request.messages().stream()
                .filter(m -> "system".equals(m.role()))
                .map(Message::content)
                .filter(c -> c != null && !c.isBlank())
                .findFirst().orElse(null);
        String system = built;
        if (existingSystem != null && !existingSystem.isBlank()) {
            if (built.isBlank()) {
                system = existingSystem;
            } else if (existingSystem.equals(built)) {
                system = built;
            } else {
                // 声明式判定「这条 system 是不是本循环自己声明的」——
                // 旧实现按提示词正文嗅探（contains("Loopra 是什么")），提示词一改判定就失效。
                String declared = host != null ? host.systemPrefix() : "";
                boolean ownPrefix = !declared.isBlank() && existingSystem.equals(declared);
                if (ownPrefix) {
                    // 子代理自拼 system / 注入的 ToolSystem 前缀：它是该循环的身份说明，必须保留，
                    // 通用切片补充在后。既然已确认同源，就不必再做 substring 猜测。
                    system = built + "\n\n---\n\n" + existingSystem;
                } else if (built.contains(existingSystem) || existingSystem.contains(built)) {
                    // 未知来源但与本宿主产出的内容重叠（如旧版提示词）：取更长的那份，避免拼两遍
                    system = built.length() >= existingSystem.length() ? built : existingSystem;
                } else {
                    // 未知外部 system：保留并追加，而不是丢弃
                    system = built + "\n\n---\n\n" + existingSystem;
                }
            }
        }
        if (system == null || system.isBlank()) {
            return InterceptDecision.pass();
        }
        List<Message> ctxMessages = context.messages();
        List<Message> nonSystem = ctxMessages.stream().filter(m -> !"system".equals(m.role())).toList();
        boolean ctxNeedsUpdate = ctxMessages.isEmpty() || !"system".equals(ctxMessages.get(0).role()) || !system.equals(ctxMessages.get(0).content());
        if (ctxNeedsUpdate) {
            List<Message> newCtxMessages = new ArrayList<>();
            newCtxMessages.add(new Message("system", system));
            newCtxMessages.addAll(nonSystem);
            try { context.replaceMessages(newCtxMessages); } catch (Exception e) { log.debug("[prompt] replaceMessages failed: {}", e.getMessage()); }
        }
        List<Message> reqNonSystem = request.messages().stream().filter(m -> !"system".equals(m.role())).toList();
        List<Message> newMessages = new ArrayList<>();
        newMessages.add(new Message("system", system));
        newMessages.addAll(reqNonSystem);
        ModelCallRequest effective = new ModelCallRequest(request.modelId(), newMessages, request.tools(), request.options());
        return InterceptDecision.modified(context, effective);
    }
}
