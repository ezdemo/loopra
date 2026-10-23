package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.agent.model.ToolCallEntry;
import site.sorghum.loopra.bin.project.ProjectRegistry;
import site.sorghum.loopra.bin.session.JsonlSessionStore;
import site.sorghum.loopra.bin.session.SessionStore;
import site.sorghum.loopra.web.common.ServiceException;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class AgentServiceBranchTest {
    @TempDir Path workspace;

    @ParameterizedTest @ValueSource(strings = {"codex", "claude-code"})
    void externalHistoryBranchesNeverConstructANativeAgent(String agentId) throws Exception {
        var source = new JsonlSessionStore(new ProjectRegistry().getSessionsDir(workspace.toString()));
        source.bindTo("source");
        var answer = ChatMessage.assistant("same answer", null, null);
        answer.setAcpMessageId("remote-selected");
        source.rewrite(List.of(ChatMessage.ofUser("first"), ChatMessage.assistant("same answer", null, null),
                ChatMessage.ofUser("second"), answer, ChatMessage.ofUser("future"),
                ChatMessage.assistant("later answer", null, null)));
        var binding = new SessionStore.AcpBinding(agentId, "fake-session", workspace.toString());
        source.setAcpBinding("source", binding);
        var command = List.of(Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-Dloopra.fake.expectedForkMessageId=remote-selected", "-cp",
                System.getProperty("surefire.test.class.path", System.getProperty("java.class.path")),
                FakeAcpProcess.class.getName());
        var runtime = new ExternalAcpSessions(cwd -> new AcpProcessTransport(command, Map.of(), cwd), (key, cwd) -> List.of());
        String created = null;
        try (var service = new AgentService(runtime) {
            @Override public boolean isReady() { return true; }
            @Override public boolean isNativeReady() { return false; }
        }) {
            created = service.branchSession(workspace.toString(), "source", 4);
            assertEquals(0, service.getCacheSize());
            assertEquals(4, service.getHistory(workspace.toString(), created).size());
            assertEquals(agentId, source.getAcpBinding(created).agentId());
            assertEquals("fake-fork", source.getAcpBinding(created).remoteSessionId());
            assertEquals(binding, source.getAcpBinding("source"));
            assertEquals(6, source.load("source").size());
        } finally {
            source.shutdown();
            source.delete("source");
            if (created != null) source.delete(created);
        }
    }

    @Test
    void copiesTheExactRequestedPrefix() {
        ChatMessage assistant = ChatMessage.assistant("done", List.of(new ToolCallEntry("1", "read", Map.of())), "thinking");
        ChatMessage tool = ChatMessage.tool("1", "result");
        List<ChatMessage> source = List.of(assistant, tool);

        List<ChatMessage> copied = AgentService.copyBranchMessages(source, 2);

        assertEquals(source, copied);
        assertNotSame(source, copied);
    }

    @Test
    void rejectsAnOutOfRangeBoundary() {
        assertThrows(ServiceException.class,
                () -> AgentService.copyBranchMessages(List.of(ChatMessage.ofUser("x")), 2));
    }

    @Test
    void usesTheSourceTitleForTheReplicaTitle() {
        assertEquals("[复刻]1+1=?", AgentService.branchTitle("1+1=?", "loopra-20260713170740"));
    }
}
