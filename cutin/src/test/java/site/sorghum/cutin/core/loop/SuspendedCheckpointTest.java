package site.sorghum.cutin.core.loop;

import org.junit.jupiter.api.Test;

import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

class SuspendedCheckpointTest {
    @Test
    void suspensionCheckpointsMutationsBeforeReturningAndReentryUsesThem() throws Exception {
        DefaultLoopEngine engine = new DefaultLoopEngine();
        LoopProgram program = LoopProgram.builder("approval")
                .node("model", NodeType.CODE, context -> {
                    context.putVariable("pending", "current-call");
                    return new StepResult.Suspend("approval required");
                })
                .node("tool", NodeType.CODE, context -> {
                    context.putVariable("executed", context.variables().get("pending"));
                    return StepResult.Exit.INSTANCE;
                })
                .start("model")
                .build();

        LoopHandle handle = engine.run(program, Map.of("pending", "old-call"));
        LoopResult pending = handle.result().get(5, TimeUnit.SECONDS);
        assertEquals(LoopResult.Status.SUSPENDED, pending.status());
        assertEquals("current-call", pending.finalSnapshot().variables().get("pending"));
        assertEquals(pending.finalSnapshot(), handle.snapshot());

        LoopResult resumed = handle.reenter(new ReentryRequest(
                "tool", handle.snapshot().stateVersion(), Map.of(), "approved"))
                .get(5, TimeUnit.SECONDS);
        assertEquals(LoopResult.Status.COMPLETED, resumed.status());
        assertEquals("current-call", resumed.finalSnapshot().variables().get("executed"));
    }
}
