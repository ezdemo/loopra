package site.sorghum.loopra.integration.cutin.plugin.exit;

import site.sorghum.cutin.core.context.DefaultLoopContext;

/**
  * 持有 Loopra 回合退出策略（GoalGuard、无工具降级、自愈回退）的宿主切片。
 */
public interface LoopraExitHost {

    /**
      * 决定当前退出请求是否应被否决。
     *
      * @return 当循环应继续执行下一次模型步骤时返回 true
     */
    boolean continueAfterExit(DefaultLoopContext context);
}
