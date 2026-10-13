package site.sorghum.loopra.bin.agent.hitl;

import org.junit.jupiter.api.Test;
import org.noear.snack4.ONode;

import site.sorghum.loopra.bin.agent.model.HitlState;
import site.sorghum.loopra.tool.AgentOutput;

import static org.junit.jupiter.api.Assertions.*;

class HitlManagerTest {

    @Test
    void cyclesModesAndKeepsLegacyBooleanCompatibility() {
        HitlManager manager = new HitlManager("false");
        assertEquals("free", manager.getHitlMode());
        manager.toggleHitl();
        assertEquals("approval", manager.getHitlMode());
        manager.toggleHitl();
        assertEquals("auto", manager.getHitlMode());
        manager.toggleHitl();
        assertEquals("free", manager.getHitlMode());
        assertEquals("approval", new HitlManager("true").getHitlMode());
    }

    @Test
    void storesHumanReviewDecisionWithoutRunningPolicyAgain() {
        HitlManager manager = new HitlManager("free");
        String prompt = manager.requestApproval(toolCalls("read"), "content", "reasoning",
                AgentOutput.NOOP, "AI 未批准，交由人工决定");
        assertEquals(HitlState.PENDING, manager.getState());
        assertTrue(prompt.contains("AI 未批准"));
        assertEquals("read", manager.getPendingHITTcList().get(0).name());
        manager.approveHITL();
        assertEquals(HitlState.APPROVED, manager.getState());
    }

    @Test
    void pendingBatchIsDrainedExactlyOnce() {
        HitlManager manager = new HitlManager("auto");
        manager.requestApproval(toolCalls("bash"), "content", "reasoning", AgentOutput.NOOP, null);
        HitlManager.PendingHITLState first = manager.drainPendingHITL();
        assertEquals("content", first.content());
        assertEquals("reasoning", first.reasoningContent());
        assertEquals("bash", first.tcList().get(0).name());
        assertNull(manager.drainPendingHITL().toolCalls());
        manager.resetState();
        assertFalse(manager.hasPendingHITL());
    }

    private static ONode toolCalls(String name) {
        ONode calls = new ONode().asArray();
        calls.addNew().then(call -> {
            call.set("id", "call-1");
            call.getOrNew("function").then(function -> {
                function.set("name", name);
                function.set("arguments", "{}");
            });
        });
        return calls;
    }
}
