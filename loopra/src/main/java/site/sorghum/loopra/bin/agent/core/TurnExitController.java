package site.sorghum.loopra.bin.agent.core;

import lombok.extern.slf4j.Slf4j;
import site.sorghum.cutin.core.context.DefaultLoopContext;
import site.sorghum.loopra.bin.agent.context.ConversationContext;
import site.sorghum.loopra.bin.agent.spi.GoalGuard;
import site.sorghum.loopra.integration.cutin.plugin.exit.LoopraExitHost;
import site.sorghum.loopra.tool.LogLevel;

import java.io.IOException;
import java.nio.file.Path;

/**
 * 回合退出决策宿主。
 * <p>负责无工具调用轮次的退出仲裁，以及 Goal 守卫（未关闭的持久化 Goal 会阻止本轮收尾）。</p>
 * <p>{@code finish} 分支是历史路径：显式结束工具移除后已没有调用方写入该退出原因，
 * 相关方法保留只为兼容既有调用点。</p>
 */
@Slf4j
final class TurnExitController implements LoopraExitHost {

    private final AgentLoop loop;

    /** 任务完成标志 —— 由 {@link #finish(String)} 设置，非空时主循环将退出并返回该内容 */
    private volatile String finishContent = null;

    @lombok.Setter
    private volatile GoalGuard goalGuard;
    /** Goal 生命周期只由拥有会话的主代理约束，子代理共享 sessionId 但不拥有 Goal。 */
    @lombok.Setter
    private volatile boolean goalGuardEnabled = true;

    TurnExitController(AgentLoop loop) {
        this.loop = loop;
    }

    void finish(String content) {
        if (content == null || content.isBlank()) {
            // 尝试从上下文获取最后一条 assistant 回复作为回退
            String lastAssistant = loop.ctx().getLastAssistantContent();
            if (lastAssistant != null && !lastAssistant.isBlank()) {
                content = lastAssistant;
                log.info("[loop] finish content 为空，使用最后一条 assistant 回复作为回退");
            } else {
                content = "(completed)";
                log.info("[loop] finish content 为空且无 assistant 回复可回退，使用默认值");
            }
        }
        this.finishContent = content;
        loop.getModelProvider().abortStream();
        log.info("[loop] 工具请求完成任务，即将退出循环");
    }

    /** 当前是否有待消费的 finish 请求。 */
    String pendingFinishContent() {
        return finishContent;
    }

    @Override
    public boolean continueAfterExit(DefaultLoopContext context) {
        String reason = String.valueOf(context.variables().getOrDefault("loopraExitReason", ""));
        return switch (reason) {
            case "finish" -> {
                String requested = takeFinishContentIfAllowed();
                if (requested != null) {
                    context.putVariable("loopraTurnResult", requested);
                    yield false;
                }
                yield true;
            }
            case "no_tool" -> decideNoToolExit(context);
            default -> false;
        };
    }

    private boolean decideNoToolExit(DefaultLoopContext context) {
        String candidate = String.valueOf(
                context.variables().getOrDefault("loopraNoToolCandidate", ""));
        Object rawStreak = context.variables().getOrDefault("loopraNoToolStreak", 1);
        int streak = rawStreak instanceof Number number ? number.intValue() : 1;
        GoalGuard.GoalView openGoal = loadOpenGoalQuietly();
        boolean shouldExit = (openGoal != null && !openGoal.requiresAgentWork())
                || (loop.terminateOnNoToolCall() && openGoal == null)
                || streak >= 3;
        if (shouldExit) {
            String prefix = openGoal != null ? "[Goal 尚未关闭，后续回合可继续]\n" : "";
            context.putVariable("loopraTurnResult", prefix + candidate);
            return false;
        }
        loop.ctx().addUser(openGoal != null
                ? "[Goal guard] Goal 尚未关闭。请继续执行当前步骤，记录证据，并调用 goal_complete 后再结束。"
                : ConversationContext.NO_TOOL_CALL_NOTICE);
        return true;
    }

    private GoalGuard.GoalView loadOpenGoalQuietly() {
        try {
            return loadOpenGoal();
        } catch (Exception exception) {
            log.warn("[goal] 读取当前 Goal 失败: {}", exception.getMessage());
            return null;
        }
    }

    /** Goal 守卫是否生效（存在守卫实例且未被子代理禁用）。 */
    boolean goalGuardActive() {
        return goalGuardEnabled && goalGuard != null;
    }

    String currentGoalInstruction() {
        if (!goalGuardEnabled || goalGuard == null) return "";
        try {
            return goalGuard.instruction(loadOpenGoal());
        } catch (Exception e) {
            log.warn("[goal] 读取当前 Goal 失败", e);
            return "## Goal 状态不可用\n持久化 Goal 暂时无法读取。不要声称目标已完成；可以说明错误并结束当前回合。"
                    + "若持续无法读取，可提示用户执行 `/goal reset` 清除损坏快照后重试。";
        }
    }

    GoalGuard.GoalView loadOpenGoal() throws IOException {
        String sessionId = loop.getSessionId();
        if (goalGuard == null || sessionId == null || sessionId.isBlank()
                || loop.getToolRegistry().getEnvironment() == null
                || loop.getToolRegistry().getEnvironment().stateRoot() == null) {
            return null;
        }
        Path stateRoot = loop.getToolRegistry().getEnvironment().stateRoot();
        return goalGuard.openGoal(stateRoot, sessionId);
    }

    private String takeFinishContentIfAllowed() {
        String requested = finishContent;
        finishContent = null;
        if (requested == null || !goalGuardEnabled || goalGuard == null) return requested;
        try {
            GoalGuard.GoalView goal = loadOpenGoal();
            if (goal == null || !goal.requiresAgentWork()) return requested;
            String reminder = "[Goal guard] 当前 Goal 仍在推进：" + goal.title()
                    + "（" + goal.progressText() + "）。请继续当前步骤并调用 goal_complete；"
                    + "只有确实需要用户输入或外部状态变化时才调用 goal_block。";
            loop.injectUserMessage(reminder);
            loop.safeOutput("goalFinishGuard", () -> loop.getOutput().onLog(LogLevel.WARN, reminder));
            loop.getModelProvider().resetStreamAbort();
            return null;
        } catch (Exception e) {
            String reminder = "[Goal guard] 无法读取持久化 Goal 状态，已拒绝本轮收尾：" + e.getMessage()
                    + "。若持续无法读取，可提示用户执行 `/goal reset` 清除损坏快照后重试。";
            loop.injectUserMessage(reminder);
            loop.safeOutput("goalFinishGuard", () -> loop.getOutput().onLog(LogLevel.ERROR, reminder));
            loop.getModelProvider().resetStreamAbort();
            return null;
        }
    }

    void discardFinishRequest() {
        finishContent = null;
        loop.getModelProvider().resetStreamAbort();
    }
}
