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
import site.sorghum.loopra.bin.agent.prompt.DEFAULT_PROMPT;
import site.sorghum.loopra.bin.agent.prompt.EnvInfoUtil;
import site.sorghum.loopra.bin.tool.ToolSystemInitializer;

import java.nio.file.Path;
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
        PromptSliceProvider core = ctx -> PromptSlice.of("core-identity", DEFAULT_PROMPT.PROMPT, 100);
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
            // 静态文案与 AgentLoop.buildToolInstructions 共用 ToolContract 单一来源，动态尾部（Goal/Plan）由宿主提供
            boolean terminate = false;
            try {
                if (host instanceof site.sorghum.loopra.bin.agent.core.AgentLoop al) {
                    terminate = al.terminateOnNoToolCall();
                }
            } catch (Exception ignored) {
                // 方法不可用时按 false 处理
            }
            String dynamic = host != null ? host.dynamicToolContractTail() : "";
            return PromptSlice.of("tool-contract", ToolContract.build(terminate, dynamic), 600);
        };
        PromptSliceProvider doc = ctx -> {
            Path ws = host == null ? null : host.workspace();
            String d = ToolSystemInitializer.loadProjectMd(ws);
            if (d == null || d.isBlank()) return null;
            return PromptSlice.of("project-doc", d.trim(), 900);
        };
        builtIns.add(core);
        builtIns.add(skill);
        builtIns.add(env);
        builtIns.add(toolContract);
        builtIns.add(doc);
        for (PromptSliceProvider p : builtIns) registry.register(p);
    }

    private InterceptDecision inject(InterceptContext intercept) {
        Object payload = intercept.payload();
        if (!(payload instanceof ModelCallRequest request)) {
            return InterceptDecision.pass();
        }
        LoopContext context = intercept.context();
        String built = registry != null ? registry.assemble(context) : "";
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
                boolean existingIsCoreStyle = existingSystem.contains("Loopra 是什么") || existingSystem.contains("您已启动 Loopra");
                boolean builtIsCoreStyle = built.contains("Loopra 是什么");
                if (existingIsCoreStyle && builtIsCoreStyle) {
                    system = built;
                } else if (!existingIsCoreStyle && builtIsCoreStyle) {
                    system = built + "\n\n---\n\n" + existingSystem;
                } else if (built.contains(existingSystem) || existingSystem.contains(built)) {
                    system = built.length() >= existingSystem.length() ? built : existingSystem;
                } else {
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
