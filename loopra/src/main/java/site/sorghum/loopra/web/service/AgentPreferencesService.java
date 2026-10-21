package site.sorghum.loopra.web.service;

import org.noear.snack4.ONode;
import org.noear.solon.annotation.Component;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import site.sorghum.loopra.bin.acp.AcpConfigOption;
import com.agentclientprotocol.sdk.error.AcpProtocolException;
import site.sorghum.loopra.web.common.ServiceException;

import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.*;

/** User defaults are independent of both browser origins and conversation metadata. */
@Component
public class AgentPreferencesService {
    private static final Logger log = LoggerFactory.getLogger(AgentPreferencesService.class);
    private final Path file;

    public AgentPreferencesService() {
        this(Path.of(System.getProperty("user.home"), ".loopra", "agent-preferences.json"));
    }

    AgentPreferencesService(Path file) { this.file = file; }

    public record Preferences(String selectedAgent, Map<String, Map<String, Object>> agents) {}

    public synchronized Preferences get() {
        if (!Files.exists(file)) return new Preferences(null, Map.of());
        try {
            Map<?, ?> root = ONode.ofJson(Files.readString(file)).toBean(Map.class);
            String selected = root.get("selectedAgent") instanceof String id ? id : null;
            if (selected != null) validateAgent(selected);
            Map<String, Map<String, Object>> agents = new LinkedHashMap<>();
            if (root.get("agents") instanceof Map<?, ?> entries) {
                for (var entry : entries.entrySet()) {
                    if (!(entry.getKey() instanceof String id) || !(entry.getValue() instanceof Map<?, ?> values)) continue;
                    validateAgent(id);
                    Map<String, Object> choices = new LinkedHashMap<>();
                    values.forEach((key, value) -> {
                        if (key instanceof String name && !"plan".equals(name)
                                && (value instanceof String || value instanceof Boolean)) choices.put(name, value);
                    });
                    agents.put(id, Map.copyOf(choices));
                }
            }
            return new Preferences(selected, Map.copyOf(agents));
        } catch (Exception e) {
            throw new ServiceException("读取 Agent 偏好失败: " + e.getMessage());
        }
    }

    public synchronized Preferences select(String agent) {
        validateAgent(agent);
        Preferences current = get();
        Preferences next = new Preferences(agent, current.agents());
        save(next);
        return next;
    }

    /** Only successful, explicit user changes update the defaults for future conversations. */
    public synchronized void remember(String agent, List<AcpConfigOption> options) {
        validateAgent(agent);
        Preferences current = get();
        Map<String, Object> values = new LinkedHashMap<>();
        for (var option : options) {
            if (!"plan".equals(option.id()) && option.accepts(option.currentValue()))
                values.put(option.id(), option.currentValue());
        }
        Map<String, Map<String, Object>> agents = new LinkedHashMap<>(current.agents());
        agents.put(agent, Map.copyOf(values));
        save(new Preferences(current.selectedAgent(), agents));
    }

    @FunctionalInterface
    public interface ConfigWriter {
        List<AcpConfigOption> apply(String id, Object value) throws Exception;
    }

    /** Model changes can expose different effort choices; revalidate after every write. */
    public List<AcpConfigOption> restore(String agent, List<AcpConfigOption> initial, ConfigWriter writer) throws Exception {
        Map<String, Object> saved = get().agents().getOrDefault(agent, Map.of());
        List<AcpConfigOption> current = initial;
        List<String> ids = new ArrayList<>(saved.keySet());
        ids.sort(Comparator.comparingInt(id -> initial.stream()
                .anyMatch(option -> option.id().equals(id) && ("model".equals(id) || "model".equals(option.category()))) ? 0 : 1));
        for (String id : ids) {
            if ("plan".equals(id)) continue;
            Object value = saved.get(id);
            var option = current.stream().filter(item -> item.id().equals(id)).findFirst().orElse(null);
            if (option == null || !option.accepts(value) || Objects.equals(option.currentValue(), value)) continue;
            try {
                current = writer.apply(id, value);
            } catch (com.agentclientprotocol.sdk.spec.AcpClientSession.AcpError | AcpProtocolException
                     | ServiceException | IllegalArgumentException e) {
                // Removed or rejected choices do not block a draft; transport failures still propagate.
                log.warn("[agent-preferences] 恢复 Agent 偏好失败，已忽略: agent={}, id={}, 原因={}", agent, id, e.getMessage());
            }
        }
        return current;
    }

    private static void validateAgent(String agent) { ExternalAcpProviders.isExternal(agent); }

    private void save(Preferences preferences) {
        Path temporary = null;
        try {
            Files.createDirectories(file.toAbsolutePath().getParent());
            temporary = Files.createTempFile(file.toAbsolutePath().getParent(), "agent-preferences-", ".tmp");
            Files.writeString(temporary, ONode.serialize(preferences));
            try {
                Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException e) {
                Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (IOException e) {
            throw new ServiceException("保存 Agent 偏好失败: " + e.getMessage());
        } finally {
            if (temporary != null) try { Files.deleteIfExists(temporary); } catch (IOException ignored) {}
        }
    }
}
