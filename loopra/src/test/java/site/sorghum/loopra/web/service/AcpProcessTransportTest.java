package site.sorghum.loopra.web.service;

import com.agentclientprotocol.sdk.spec.AcpSchema.JSONRPCResponse;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import reactor.core.publisher.Mono;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

@Timeout(25)
class AcpProcessTransportTest {
    @TempDir Path root;

    @ParameterizedTest
    @ValueSource(strings = {"parent", "interrupted", "eof", "interrupted-eof"})
    void closeReapsTheAgentAndItsChildBeforeReleasingTheWorkingDirectory(String mode) throws Exception {
        boolean interrupted = mode.startsWith("interrupted");
        Path cwd = Files.createDirectory(root.resolve("workspace"));
        var ready = new CompletableFuture<Map<?, ?>>();
        var transport = new AcpProcessTransport(command(mode), Map.of(), cwd);
        Map<?, ?> pids = null;
        try {
            transport.connect(message -> message.doOnNext(value -> {
                if (value instanceof JSONRPCResponse response) ready.complete((Map<?, ?>) response.result());
            }).then(Mono.empty())).block();
            pids = ready.get(8, TimeUnit.SECONDS);
            if (interrupted) Thread.currentThread().interrupt();
            transport.close();
            assertEquals(interrupted, Thread.currentThread().isInterrupted(), "close must preserve interruption");
            Thread.interrupted();
            for (Object value : pids.values()) {
                long pid = ((Number) value).longValue();
                assertFalse(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false), "process still alive: " + pid);
            }
            Files.delete(cwd); // Windows refuses this while either process still owns the cwd.
            transport.close();
        } finally {
            Thread.interrupted();
            transport.close();
            if (pids != null) for (Object value : pids.values()) {
                ProcessHandle.of(((Number) value).longValue()).ifPresent(process -> {
                    process.destroyForcibly();
                    try { process.onExit().get(5, TimeUnit.SECONDS); }
                    catch (Exception error) { throw new AssertionError("could not clean up test peer", error); }
                });
            }
        }
    }

    private static List<String> command(String mode) {
        return List.of(Path.of(System.getProperty("java.home"), "bin", "java").toString(), "-cp",
                System.getProperty("surefire.test.class.path", System.getProperty("java.class.path")), Peer.class.getName(), mode);
    }

    /** A real process tree whose two processes both hold the test working directory. */
    public static final class Peer {
        public static void main(String[] args) throws Exception {
            if (!args[0].equals("child")) {
                Process child = new ProcessBuilder(command("child")).start();
                if (child.getInputStream().read() != 'R') throw new IllegalStateException("child did not start");
                System.out.println("{\"jsonrpc\":\"2.0\",\"id\":\"ready\",\"result\":{\"parent\":"
                        + ProcessHandle.current().pid() + ",\"child\":" + child.pid() + "}}");
            } else System.out.println("Ready");
            System.out.flush();
            if (args[0].endsWith("eof")) System.out.close();
            Thread.sleep(Long.MAX_VALUE);
        }
    }
}
