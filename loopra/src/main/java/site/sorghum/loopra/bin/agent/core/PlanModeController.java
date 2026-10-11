package site.sorghum.loopra.bin.agent.core;

import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.ONode;
import org.noear.solon.ai.chat.tool.FunctionTool;
import site.sorghum.cutin.core.event.LoopEvent;
import site.sorghum.loopra.bin.agent.spi.SessionUsageSink;
import site.sorghum.loopra.bin.tool.ToolMetadata;
import site.sorghum.loopra.integration.cutin.plugin.plan.LoopraPlanHost;

import java.util.Map;

/**
 * 计划模式控制器 —— 会话级计划模式状态与待审查计划的拥有者。
 * <p>
 * 计划模式仅允许只读工具（工具列表过滤 + 执行拒绝 + 指令感知），
 * 由 /plan、/execute 命令切换；不修改共享的 ToolRegistry，因此不影响同项目的其他会话。
 * 持久化与事件通知通过宿主 {@link AgentLoop} 的 cutin 事件总线与
 * {@link SessionUsageSink} 完成。
 * </p>
 */
@Slf4j
final class PlanModeController implements LoopraPlanHost {

    /**
     * 计划模式动态指令 —— 激活时追加到工具协作约定末尾。
     * 放在动态尾部而非 system prompt 固定前缀，避免模式切换破坏前缀缓存稳定性。
     */
    static final String PLAN_MODE_INSTRUCTIONS = """
            ## Plan Mode（当前处于计划模式）

            - 仅只读工具可用：写入/修改/执行类工具已从工具列表移除，任何此类调用都会被直接拒绝
            - 不要尝试修改文件、执行命令等任何改变操作，也不要尝试绕过此限制
            - 先用只读工具充分探索，理解现状、明确目标、影响面与风险
            - 探索完成后用 `submit_plan` 工具提交完整执行计划供用户审查，然后向用户简要总结计划要点并结束本轮
            - 用户批准计划后系统会退出计划模式并按计划执行
            """;

    private final AgentLoop loop;

    /** 计划模式开关（会话级，仅影响本循环）。 */
    private volatile boolean planMode = false;

    /**
     * 计划模式下经 submit_plan 提交、待用户审查的执行计划。
     * /execute 批准时取出并注入为执行依据（取出即清空）。
     */
    private volatile String pendingPlan = null;

    PlanModeController(AgentLoop loop) {
        this.loop = loop;
    }

    boolean isPlanMode() {
        return planMode;
    }

    /**
     * 切换计划模式（会话级状态，仅影响本循环）。
     * <p>切换在下一步立即生效：工具列表过滤为只读集合、非只读调用被拒绝、
     * 计划模式指令注入工具约定。持久化与事件通知由上层（LoopraAgent）负责。</p>
     */
    void setPlanMode(boolean enabled) {
        this.planMode = enabled;
    }

    /**
     * 保存 submit_plan 提交的任务计划，并通过 plan_submitted 事件通知前端。
     */
    void submitPlan(String planMarkdown) {
        this.pendingPlan = planMarkdown;
        emitPlanPersistence(planMarkdown);
        ONode data = ONode.ofJson("{}").asObject();
        data.set("plan", planMarkdown != null ? planMarkdown : "");
        loop.safeOutput("planSubmitted", () -> loop.getOutput().sendEvent("plan_submitted", data.toJson()));
    }

    /** 获取待审查计划（不移除）。 */
    String getPendingPlan() {
        return pendingPlan;
    }

    /** 静默恢复持久化的待审查计划，不触发事件或重复写盘。 */
    void restorePendingPlan(String planMarkdown) {
        this.pendingPlan = planMarkdown;
    }

    /** 清除待审查计划并同步持久化。 */
    void clearPendingPlan() {
        this.pendingPlan = null;
        emitPlanPersistence(null);
    }

    /** 取出并清空待审查计划（/execute 批准时调用）。 */
    String consumePendingPlan() {
        String plan = pendingPlan;
        clearPendingPlan();
        return plan;
    }

    private void emitPlanPersistence(String planMarkdown) {
        if (loop.cutinEngine() != null) {
            String eventType = planMarkdown == null
                    ? LoopraPlanHost.PLAN_CLEARED
                    : LoopraPlanHost.PLAN_SUBMITTED;
            String loopId = loop.activeCutinHandle() != null
                    ? loop.activeCutinHandle().id()
                    : "plan";
            loop.cutinEngine().events().emit(new LoopEvent(
                    eventType,
                    loopId,
                    null,
                    Map.of("plan", planMarkdown == null ? "" : planMarkdown)
            ));
            return;
        }
        persistPendingPlan(planMarkdown);
    }

    @Override
    public void persistPendingPlan(String planMarkdown) {
        SessionUsageSink sink = loop.getSessionUsageSink();
        if (sink == null) return;
        try {
            sink.persistPendingPlan(planMarkdown);
        } catch (Exception e) {
            log.warn("[plan] 持久化待审查计划失败: {}", e.getMessage());
        }
    }

    /**
     * 将工具列表过滤为只读集合（不修改注册表及其缓存，返回新节点）。
     * 注册表中找不到对应 FunctionTool 的条目一律剔除（保守策略）。
     */
    ONode filterReadOnlyTools(ONode tools) {
        if (tools == null || !tools.isArray()) {
            return tools;
        }
        Map<String, FunctionTool> available = loop.getToolRegistry().all();
        ONode filtered = ONode.ofJson(tools.toJson()).asArray();
        filtered.getArray().removeIf(item -> {
            String name = item.get("function").get("name").getString();
            FunctionTool tool = name != null ? available.get(name) : null;
            return tool == null || !ToolMetadata.isReadOnly(tool);
        });
        return filtered;
    }
}
