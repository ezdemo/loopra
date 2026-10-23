package site.sorghum.loopra.bin.agent.environment;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Set;

/**
 * Pure-chat mode identity and tool policy.
 *
 * <p>The runtime still needs a stable directory for JSONL sessions, usage and
 * other metadata. That directory is an implementation detail and is never
 * exposed as a user project.</p>
 */
public final class ChatMode {
    public static final String WORKSPACE_HASH = "__loopra_chat__";
    public static final String WORKSPACE_NAME = "纯聊天";
    public static final Set<String> ALLOWED_COMMANDS = Set.of("help", "compact", "continue", "agree", "deny");

    /**
     * Only network-facing, read-only capabilities are available in pure chat.
     * Local file and shell tools are intentionally absent.
     */
    public static final Set<String> ALLOWED_TOOLS = Set.of(
            "webfetch",
            "websearch",
            "codesearch"
    );

    private ChatMode() {
    }

    public static Path root() {
        return Paths.get(System.getProperty("user.home"), ".loopra", "chat-workspace")
                .toAbsolutePath()
                .normalize();
    }

    public static boolean isChatHash(String hash) {
        return WORKSPACE_HASH.equals(hash);
    }

    public static boolean isChatRoot(Path path) {
        return path != null && path.toAbsolutePath().normalize().equals(root());
    }

    public static boolean isChatRoot(String path) {
        if (path == null || path.isBlank()) return false;
        try {
            return isChatRoot(Paths.get(path));
        } catch (RuntimeException ignored) {
            return false;
        }
    }
}
