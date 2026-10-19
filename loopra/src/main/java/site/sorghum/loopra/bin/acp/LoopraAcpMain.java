package site.sorghum.loopra.bin.acp;

import com.agentclientprotocol.sdk.agent.transport.StdioAcpAgentTransport;
import com.agentclientprotocol.sdk.json.AcpJsonMapper;

/** Standalone ACP entry point. Stdout is reserved exclusively for JSON-RPC. */
public final class LoopraAcpMain {
    private LoopraAcpMain() {}

    public static void main(String[] args) throws Exception {
        java.io.PrintStream protocolOutput = System.out;
        System.setOut(System.err);
        try (AcpBootstrap bootstrap = new AcpBootstrap(new StdioAcpAgentTransport(
                AcpJsonMapper.createDefault(), System.in, protocolOutput))) {
            bootstrap.startAndAwait();
        }
    }
}
