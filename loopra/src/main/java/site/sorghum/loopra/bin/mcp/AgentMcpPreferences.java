package site.sorghum.loopra.bin.mcp;

import org.noear.snack4.ONode;

import java.io.IOException;
import java.nio.file.*;
import java.util.*;

/** Per-Agent forwarding choices, independent of the shared server definitions. */
public final class AgentMcpPreferences {
    private AgentMcpPreferences() {}

    public static Path path() {
        return Path.of(System.getProperty("user.home"), ".loopra", "agent-mcp.json");
    }

    public static Map<String, Boolean> choices(String agentId) {
        return choices(path(), agentId);
    }

    public static synchronized Map<String, Boolean> choices(Path file, String agentId) {
        ONode agents = read(file).getOrNull("agents");
        ONode agent = agents == null ? null : agents.getOrNull(agentId);
        Map<String, Boolean> result = new LinkedHashMap<>();
        if (agent == null) return Map.of();
        if (!agent.isObject()) throw new IllegalStateException("Agent MCP 偏好格式错误");
        agent.getObject().forEach((name, value) -> {
            if (!value.isBoolean()) throw new IllegalStateException("Agent MCP 偏好格式错误");
            result.put(name, value.getBoolean());
        });
        return Map.copyOf(result);
    }

    public static synchronized void set(Path file, String agentId, String name, boolean enabled) {
        if (agentId == null || agentId.isBlank() || name == null || name.isBlank())
            throw new IllegalArgumentException("需要 Agent 和 MCP 名称");
        ONode root = read(file);
        root.getOrNew("agents").getOrNew(agentId).set(name, enabled);
        Path target = file.toAbsolutePath().normalize();
        Path temporary = null;
        try {
            Files.createDirectories(target.getParent());
            temporary = Files.createTempFile(target.getParent(), "agent-mcp-", ".tmp");
            Files.writeString(temporary, root.toJson());
            try { Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
            catch (AtomicMoveNotSupportedException ignored) { Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING); }
        } catch (IOException e) {
            throw new IllegalStateException("保存 Agent MCP 偏好失败");
        } finally {
            if (temporary != null) try { Files.deleteIfExists(temporary); } catch (IOException ignored) {}
        }
    }

    private static ONode read(Path file) {
        try {
            if (!Files.exists(file)) return new ONode().asObject();
            ONode root = ONode.ofJson(Files.readString(file));
            if (!root.isObject()) throw new IllegalStateException();
            ONode agents = root.getOrNull("agents");
            if (agents != null && !agents.isObject()) throw new IllegalStateException();
            return root;
        } catch (IOException | RuntimeException e) {
            throw new IllegalStateException("读取 Agent MCP 偏好失败，请检查 agent-mcp.json");
        }
    }
}
