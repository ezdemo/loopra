package site.sorghum.loopra.integration.cutin.plugin.exit;

import site.sorghum.cutin.core.context.DefaultLoopContext;
import site.sorghum.cutin.core.loop.InterceptContext;
import site.sorghum.cutin.core.loop.InterceptDecision;
import site.sorghum.cutin.core.loop.InterceptPoint;
import site.sorghum.cutin.core.plugin.AgentPlugin;
import site.sorghum.cutin.core.plugin.LoopPlugin;
import site.sorghum.cutin.core.plugin.LoopRegistrar;

/**
  * 在 cutin 退出关口执行 Loopra 的 GoalGuard / 无工具终止策略。
  * 策略本身位于 {@link LoopraExitHost} 之后，自定义宿主无需改动引擎即可替换。
 */
@AgentPlugin(id = "loopra-exit", remark = "处理循环退出信号，确保任务可以安全结束。")
public final class LoopraExitPlugin implements LoopPlugin {

    private final LoopraExitHost host;

    public LoopraExitPlugin(LoopraExitHost host) {
        this.host = host;
    }

    @Override
    public String id() {
        return "loopra-exit";
    }

    @Override
    public void register(LoopRegistrar registrar) {
        registrar.registerInterceptor(InterceptPoint.BEFORE_EXIT, -50, this::onExit);
    }

    private InterceptDecision onExit(InterceptContext context) {
        if (context.context() instanceof DefaultLoopContext defaultContext
                && host.continueAfterExit(defaultContext)) {
            return InterceptDecision.gotoNode("model");
        }
        return InterceptDecision.pass();
    }
}
