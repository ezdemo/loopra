package site.sorghum.loopra.bin.acp;

import site.sorghum.loopra.bin.agent.model.ChatMessage;
import java.io.IOException;
import java.util.List;
import java.util.Map;

/** Native session ownership behind the ACP server, independently of its transport. */
public interface AcpSessionBackend {
    String createSession(String cwd, String sessionName);
    boolean loadOrRestoreSession(String sessionId, String cwd);
    String handlePrompt(String sessionId, String text, List<String> images,
                        AcpAgentOutput output, Map<String, Object> options) throws IOException;
    void cancelPrompt(String sessionId);
    void closeSession(String sessionId);
    List<SessionInfo> listSessions();
    default List<ChatMessage> history(String sessionId) { return List.of(); }
    default boolean isCancelled(String sessionId) { return false; }
    record SessionInfo(String sessionId, String cwd) {}
}
