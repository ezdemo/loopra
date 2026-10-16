package site.sorghum.loopra.bin.command.impl;

import org.noear.solon.annotation.Component;
import site.sorghum.loopra.bin.command.ChatCommand;
import site.sorghum.loopra.bin.command.ChatCommandContext;
import site.sorghum.loopra.bin.command.MessageWrapper;

/**
 * /hitl — 切换 HITL（Human-In-The-Loop）模式。
 * <p>
 * 循环切换三种模式：
 * <ul>
 *   <li><b>free</b>（自由）— 所有工具直接执行，无需审批</li>
 *   <li><b>approval</b>（按需审批）— 普通工作区读写自动放行，其余按需确认</li>
 *   <li><b>auto</b>（自动审批）— 按需审批规则之后追加 AI 审核</li>
 * </ul>
 * </p>
 *
 * @author Sorghum
 */
@Component
public class HitlCommand implements ChatCommand {

    @Override
    public String getCommand() {
        return "hitl";
    }

    @Override
    public String getDescription() {
        return "/hitl        切换 HITL 模式（free/approval/auto）";
    }

    @Override
    public String getCommandType() {
        return "mode";
    }

    @Override
    public CommandResult execute(MessageWrapper input, ChatCommandContext context) {
        context.getAgent().toggleHitl();
        String mode = context.getAgent().getHitlMode();
        switch (mode) {
            case "approval" ->
                context.getAgent().getOutput().onReasoning("✅ HITL 模式已切换为「按需审批」— 普通工作区读写自动放行，越界及无法确认范围的操作需审批\n" +
                        "   使用 /agree 批准执行，/deny 拒绝执行\n");
            case "auto" -> context.getAgent().getOutput().onReasoning(
                    "✅ HITL 模式已切换为「自动审批」— 普通工作区操作直接放行，其余由 AI 审核，不通过时等待人工确认\n");
            default ->
                context.getAgent().getOutput().onReasoning("✅ HITL 模式已切换为「完全自动」— 跳过审核，直接执行工具\n");
        }
        return CommandResult.CONTINUE;
    }
}
