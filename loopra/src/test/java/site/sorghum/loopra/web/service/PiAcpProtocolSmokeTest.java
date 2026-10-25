package site.sorghum.loopra.web.service;

import com.agentclientprotocol.sdk.client.AcpClient;
import com.agentclientprotocol.sdk.spec.AcpSchema.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.bin.session.JsonlSessionStore;
import site.sorghum.loopra.bin.session.SessionStore.AcpCommand;
import site.sorghum.loopra.tool.AgentOutput;

import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.*;

/** Installed svkozak/pi-acp and Pi. Queries local settings; never sends a model task. */
@EnabledIfSystemProperty(named = "loopra.test.pi.protocol", matches = "true")
@Timeout(60)
class PiAcpProtocolSmokeTest {
    @TempDir Path workspace;

    @Test void installedAdapterAdvertisesLoadButNoFork() {
        assertTrue(PiAcpProcess.detect().available(), PiAcpProcess.detect().reason());
        try (var client = AcpClient.sync(PiAcpProcess.create(workspace)).requestTimeout(Duration.ofSeconds(25)).build()) {
            var response = client.initialize(new InitializeRequest(1,
                    new ClientCapabilities(new FileSystemCapability(false, false), false, null, null),
                    new Implementation("loopra-pi-protocol-test", "1", "Loopra Pi Protocol Test"), null));
            assertEquals(1, response.protocolVersion());
            assertTrue(response.agentCapabilities().loadSession());
            var sessions = response.agentCapabilities().sessionCapabilities();
            assertTrue(sessions == null || sessions.fork() == null,
                    "If the upstream adapter adds fork, verify historical reply targeting before enabling the UI");
        }
    }

    @Test void workbenchReceivesThinkingAndCommandsAndExecutesModeQueriesWithoutInference() throws Exception {
        var commands = new CompletableFuture<List<AcpCommand>>();
        var store = new JsonlSessionStore(workspace.resolve("transcript"));
        store.bindTo("commands");
        var output = new AcpTranscriptOutput(AgentOutput.NOOP, store);
        try (var client = new AcpWorkbenchClient(PiAcpProcess.create(workspace), output)) {
            client.setCommandsListener(items -> {
                if (items.stream().anyMatch(command -> "follow-up".equals(command.name()))) commands.complete(items);
            });
            client.open(workspace.toString());
            assertTrue(client.configOptions().stream().anyMatch(option -> "model".equals(option.category())));
            var thinking = client.configOptions().stream().filter(option -> "thought_level".equals(option.category())).findFirst().orElseThrow();
            assertFalse(thinking.options().isEmpty());
            assertTrue(thinking.accepts(thinking.currentValue()));
            Set<String> names = commands.get(10, TimeUnit.SECONDS).stream().map(AcpCommand::name).collect(Collectors.toSet());
            assertTrue(names.containsAll(Set.of("compact", "autocompact", "steering", "follow-up", "session", "name", "export")), names.toString());
            for (String command : List.of("/steering", "/follow-up")) {
                assertEquals(StopReason.END_TURN, client.prompt(UserMessage.of(command), Map.of()).stopReason());
            }
            output.flush();
            String text = store.load("commands").stream().map(message -> message.getContent()).collect(Collectors.joining("\n"));
            assertTrue(text.contains("Steering mode:"), text);
            assertTrue(text.contains("Follow-up mode:"), text);
        } finally { store.shutdown(); }
    }
}
