package site.sorghum.cutin.runtime;

import org.junit.jupiter.api.Test;
import site.sorghum.cutin.core.loop.DefaultLoopEngine;
import site.sorghum.cutin.core.loop.LoopHandle;
import site.sorghum.cutin.core.loop.LoopProgram;
import site.sorghum.cutin.core.loop.LoopResult;
import site.sorghum.cutin.core.loop.NodeType;
import site.sorghum.cutin.core.loop.StepResult;

import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 子代理运行时测试：验证子代理能在同一个引擎上启动并等待完成。
 */
class SubagentRuntimeTest {

    /** 应能在同一引擎上启动子代理并拿到正常完成的结果。 */
    @Test
    void spawnsAndAwaitsSubagentOnSameEngine() throws Exception {
        DefaultLoopEngine engine = new DefaultLoopEngine();
        SubagentRuntime subagents = new SubagentRuntime(engine);

        LoopProgram program = LoopProgram.builder("subagent")
            .node("mark", NodeType.CODE, context -> {
                context.putVariable("subagentRan", true);
                return StepResult.Exit.INSTANCE;
            })
            .build();

        LoopHandle handle = subagents.spawn(new SubagentRequest(
            "do something",
            program,
            Map.of("task", "ignored"),
            null
        ));
        LoopResult result = handle.result().get(5, TimeUnit.SECONDS);

        assertEquals(LoopResult.Status.COMPLETED, result.status());
        assertTrue((boolean) result.finalSnapshot().variables().get("subagentRan"));
    }
}
