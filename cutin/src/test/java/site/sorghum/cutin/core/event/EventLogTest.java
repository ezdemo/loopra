package site.sorghum.cutin.core.event;

import org.junit.jupiter.api.Test;
import site.sorghum.cutin.core.loop.DefaultLoopEngine;
import site.sorghum.cutin.core.loop.LoopHandle;
import site.sorghum.cutin.core.loop.LoopProgram;
import site.sorghum.cutin.core.loop.LoopResult;
import site.sorghum.cutin.core.loop.NodeType;
import site.sorghum.cutin.core.loop.Steps;

import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 事件日志测试：验证一次简单循环会发布生命周期事件。
 */
class EventLogTest {

    /** 简单循环应发布 PRE_LOOP、CHECKPOINT 与 POST_LOOP 事件。 */
    @Test
    void emitsLifecycleEventsForASimpleRun() throws Exception {
        DefaultLoopEngine engine = new DefaultLoopEngine();
        InMemoryEventLog log = new InMemoryEventLog();
        engine.addEventHandler(log);

        LoopProgram program = LoopProgram.builder("events")
            .node("finish", NodeType.CODE, Steps.finish())
            .build();

        LoopHandle handle = engine.run(program, Map.of());
        LoopResult result = handle.result().get(5, TimeUnit.SECONDS);

        assertEquals(LoopResult.Status.COMPLETED, result.status());
        assertTrue(log.events().stream().anyMatch(event -> event.type().equals("PRE_LOOP")));
        assertTrue(log.events().stream().anyMatch(event -> event.type().equals("CHECKPOINT")));
        assertTrue(log.events().stream().anyMatch(event -> event.type().equals("POST_LOOP")));
    }
}
