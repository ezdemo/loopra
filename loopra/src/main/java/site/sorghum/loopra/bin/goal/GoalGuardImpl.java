package site.sorghum.loopra.bin.goal;

import site.sorghum.loopra.bin.agent.spi.GoalGuard;

import java.io.IOException;
import java.nio.file.Path;

/**
 * GoalGuard 的 Goal 状态机实现 —— 将内核 SPI 桥接到 harness 的 Goal 持久化与指令生成。
 * <p>
 * 由 LoopraAgent 在构造 AgentLoop 后注入，使内核无需感知 Goal 模型即可享受
 * Goal 指令注入与无工具守卫能力。
 * </p>
 *
 * @author Sorghum
 */
public class GoalGuardImpl implements GoalGuard {

    private final GoalService goalService = new GoalService();

    @Override
    public GoalView openGoal(Path workspace, String sessionId) throws IOException {
        Goal goal = GoalRuntime.forWorkspace(workspace, sessionId).load();
        return goal != null && goal.isOpen() ? new GoalViewAdapter(goal) : null;
    }

    @Override
    public String instruction(GoalView goal) {
        if (goal == null) {
            return "";
        }
        if (goal instanceof GoalViewAdapter adapter) {
            return goalService.instruction(adapter.goal());
        }
        return "";
    }

    /** Goal 只读视图适配器，包装 harness 内部的 Goal 模型。 */
    private record GoalViewAdapter(Goal goal) implements GoalView {
        @Override
        public boolean requiresAgentWork() {
            return goal.requiresAgentWork();
        }

        @Override
        public String title() {
            return goal.getTitle();
        }

        @Override
        public String progressText() {
            return goal.progressText();
        }
    }
}
