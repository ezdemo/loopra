package site.sorghum.loopra.bin.acp;

import site.sorghum.loopra.bin.agent.core.LoopraAgent;
import java.util.function.Supplier;

/** Adapts Native's suspended HITL turn to ACP's outstanding permission request. */
public final class AcpPromptExecutor {
    private AcpPromptExecutor() {}

    public static String run(LoopraAgent agent, AcpAgentOutput output, Supplier<String> firstTurn) {
        String result = firstTurn.get();
        while (!agent.noPendingHITL() && !agent.isAbortRequested()) {
            Boolean decision = output.takePermissionDecision();
            if (decision == null) {
                agent.abort();
                break;
            }
            if (decision) agent.approveHITL();
            else agent.denyHITL();
            result = agent.chat(null);
        }
        return result;
    }
}
