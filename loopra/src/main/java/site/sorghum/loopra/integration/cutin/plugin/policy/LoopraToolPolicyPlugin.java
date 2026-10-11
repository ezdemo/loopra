package site.sorghum.loopra.integration.cutin.plugin.policy;

import org.noear.snack4.ONode;
import org.noear.solon.ai.chat.tool.FunctionTool;
import site.sorghum.cutin.core.loop.InterceptContext;
import site.sorghum.cutin.core.loop.InterceptDecision;
import site.sorghum.cutin.core.loop.InterceptPoint;
import site.sorghum.cutin.core.plugin.AgentPlugin;
import site.sorghum.cutin.core.plugin.LoopPlugin;
import site.sorghum.cutin.core.plugin.LoopRegistrar;
import site.sorghum.cutin.core.tool.ToolCall;
import site.sorghum.loopra.bin.agent.resilient.StormBreaker;
import site.sorghum.loopra.bin.tool.ToolMetadata;

/**
  * Loopra 面向工具的策略：工具执行前的计划模式只读约束与 StormBreaker 抑制。
 */
@AgentPlugin(id = "loopra-tool-policy", remark = "按安全策略检查和约束工具调用。")
public final class LoopraToolPolicyPlugin implements LoopPlugin {

    private final LoopraPolicyHost host;

    public LoopraToolPolicyPlugin(LoopraPolicyHost host) {
        this.host = host;
    }

    @Override
    public String id() {
        return "loopra-tool-policy";
    }

    @Override
    public void register(LoopRegistrar registrar) {
        registrar.registerInterceptor(InterceptPoint.BEFORE_TOOL, -100, this::guardToolCall);
    }

    private InterceptDecision guardToolCall(InterceptContext context) {
        if (!(context.payload() instanceof ToolCall call)) {
            return InterceptDecision.pass();
        }
        // 优先用 cutin 元数据，确保网关禁用/移除后仍能正确判断
        boolean readOnly = false;
        boolean stormExempt = false;
        boolean hasMeta = false;
        try {
            var cutinReq = host.getCutinTools();
            if (cutinReq != null) {
                var def = cutinReq.find(call.toolId()).orElse(null);
                if (def != null) {
                    readOnly = def.definition().metadata().readOnly();
                    stormExempt = def.definition().metadata().stormExempt();
                    hasMeta = true;
                }
            }
        } catch (Exception ignored) {
            // 元数据查询失败时回退到 legacy 工具判断
        }
        FunctionTool tool = host.getToolRegistry().get(call.toolId());
        if (!hasMeta) {
            if (tool != null) {
                readOnly = ToolMetadata.isReadOnly(tool);
                stormExempt = ToolMetadata.isStormExempt(tool);
                hasMeta = true;
            }
        }
        if (host.isPlanMode() && hasMeta && !readOnly) {
            return InterceptDecision.replace(host.rejectCutinTool(
                    call,
                    "当前处于计划模式，仅允许只读工具；本次调用已被拒绝。请继续使用只读工具探索，完成后用 submit_plan 提交计划。",
                    "plan_mode"
            ));
        }
        if (hasMeta && !stormExempt) {
            String argumentsJson = ONode.ofBean(call.arguments()).toJson();
            StormBreaker.SuppressResult suppression = host.stormBreaker().inspect(
                    call.toolId(), argumentsJson, readOnly);
            if (suppression.suppressed()) {
                host.markCutinStormSuppressed();
                return InterceptDecision.replace(host.rejectCutinTool(
                        call, suppression.reason(), "storm"
                ));
            }
        }
        return InterceptDecision.pass();
    }
}
