package site.sorghum.loopra.bin.builtin;

import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.ONode;
import org.noear.solon.ai.annotation.ToolMapping;
import org.noear.solon.ai.chat.tool.AbsToolProvider;
import org.noear.solon.ai.chat.tool.FunctionTool;
import org.noear.solon.annotation.Component;
import org.noear.solon.annotation.Param;
import site.sorghum.loopra.tool.AgentLoopController;
import site.sorghum.loopra.tool.ErrorMessages;
import site.sorghum.loopra.tool.SolonToTools;
import site.sorghum.loopra.tool.ToolContext;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

/**
 * submit_plan 工具 —— 计划模式下提交执行计划供用户审查。
 * <p>
 * 计划的完整闭环：
 * <ol>
 *   <li>{@code /plan} 进入计划模式（仅只读工具可用）</li>
 *   <li>LLM 探索后调用本工具提交计划，计划保存在 AgentLoop 并经
 *       {@code plan_submitted} 事件推送前端</li>
 *   <li>用户 {@code /execute} 批准 → 计划注入为执行指令，全部工具恢复</li>
 * </ol>
 * 只读工具（见 ToolMetadata.BUILT_IN_READ_ONLY_TOOLS），计划模式下可用。
 * </p>
 *
 * @author Sorghum
 */
@Slf4j
@Component
public class SubmitPlanTool extends AbsToolProvider implements SolonToTools {

    @ToolMapping(name = "submit_plan", description = """
            提交执行计划供用户审查（计划模式的核心产物）。
            在计划模式下完成探索后调用：
            - steps：有序执行步骤，每步应具体、可执行、可验证
            - summary：计划目标与思路的一句话概述（可选）
            - risks：风险与注意事项（可选）
            提交成功后，向用户简要总结计划要点并结束本轮，等待用户确认；不要执行任何修改操作。
            """)
    public String submitPlan(
            @Param(name = "steps", description = "有序执行步骤（JSON 字符串数组，或每行一步的文本），每步应具体可执行") String steps,
            @Param(name = "summary", description = "计划目标与思路的一句话概述", required = false) String summary,
            @Param(name = "risks", description = "风险与注意事项", required = false) String risks,
            @Param(name = "ctx", required = false) ToolContext ctx) {

        AgentLoopController controller = ctx.getLoopController();
        if (controller == null) {
            return "{\"error\":\"no agent loop controller available\"}";
        }
        if (!controller.isPlanMode()) {
            return "{\"error\":\"当前不在计划模式。请先用 /plan 进入计划模式，或直接执行任务而无需提交计划\"}";
        }

        List<String> stepList = parseSteps(steps);
        if (stepList.isEmpty()) {
            return ErrorMessages.SUBMIT_PLAN_REQUIRES_STEPS;
        }

        String plan = buildPlanMarkdown(summary, stepList, risks);
        controller.submitPlan(plan);
        log.info("[plan] 收到执行计划提交: {} 步", stepList.size());

        return "{\"status\":\"submitted\",\"message\":\"计划已提交，等待用户确认。"
                + "请向用户简要总结计划要点并结束本轮，不要执行任何修改操作。"
                + "用户批准计划后系统会自动退出计划模式并按计划执行。\"}";
    }

    /**
     * 解析步骤：优先按 JSON 字符串数组解析，失败或非 JSON 时按行拆分
     * （去掉常见列表前缀，如 "- "、"1. "）。
     */
    static List<String> parseSteps(String raw) {
        List<String> result = new ArrayList<>();
        if (raw == null || raw.isBlank()) {
            return result;
        }
        String trimmed = raw.trim();
        if (trimmed.startsWith("[")) {
            try {
                ONode arr = ONode.ofJson(trimmed);
                if (arr.isArray()) {
                    for (ONode item : arr.getArray()) {
                        String s = item.getString();
                        if (s != null && !s.isBlank()) {
                            result.add(s.trim());
                        }
                    }
                    return result;
                }
            } catch (Exception e) {
                log.warn("[plan] steps JSON 解析失败，回退按行解析: {}", e.getMessage());
            }
        }
        for (String line : trimmed.split("\\r?\\n")) {
            String s = line.replaceAll("^[\\-*•\\d.、)）\\s]+", "").trim();
            if (!s.isEmpty()) {
                result.add(s);
            }
        }
        return result;
    }

    /** 组装计划 Markdown（作为 /execute 批准后注入的执行依据）。 */
    static String buildPlanMarkdown(String summary, List<String> steps, String risks) {
        StringBuilder sb = new StringBuilder();
        if (summary != null && !summary.isBlank()) {
            sb.append("**概述**：").append(summary.trim()).append("\n\n");
        }
        sb.append("**执行步骤**：\n");
        for (int i = 0; i < steps.size(); i++) {
            sb.append(i + 1).append(". ").append(steps.get(i)).append('\n');
        }
        if (risks != null && !risks.isBlank()) {
            sb.append("\n**风险与注意事项**：").append(risks.trim()).append('\n');
        }
        return sb.toString();
    }

    @Override
    public Collection<FunctionTool> getSolonTools() {
        return this.getTools();
    }
}
