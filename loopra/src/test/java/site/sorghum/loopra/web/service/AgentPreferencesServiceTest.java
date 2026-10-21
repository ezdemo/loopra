package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import site.sorghum.loopra.bin.acp.AcpConfigOption;
import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.controller.AgentEngineController;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

class AgentPreferencesServiceTest {
    @TempDir Path home;

    private Path file() { return home.resolve(".loopra/agent-preferences.json"); }
    private AgentPreferencesService store() { return new AgentPreferencesService(file()); }

    private static AcpConfigOption select(String id, String category, String current, String... values) {
        return new AcpConfigOption(id, id, "", category, "select", current,
                Arrays.stream(values).map(value -> new AcpConfigOption.Value(value, value, "", null)).toList());
    }
    private static AcpConfigOption bool(boolean value) {
        return new AcpConfigOption("fast", "Fast", "", "", "boolean", value, List.of());
    }

    @Test void restartPreservesSelectionAndIndependentAgentChoices() {
        var preferences = store();
        assertNull(preferences.get().selectedAgent());
        preferences.select("codex");
        preferences.remember("codex", List.of(
                select("model", "model", "deepseek", "deepseek", "sol"),
                select("mode", "mode", "full-access", "auto-review", "full-access"),
                select("effort", "thought_level", "max", "high", "max"),
                bool(false), select("plan", "", "on", "off", "on")));
        preferences.remember("claude-code", List.of(select("model", "model", "sonnet", "sonnet")));
        preferences.select("claude-code");
        var restarted = store().get();
        assertEquals("claude-code", restarted.selectedAgent());
        assertEquals(Map.of("model", "deepseek", "mode", "full-access", "effort", "max", "fast", false),
                restarted.agents().get("codex"));
        assertEquals(Map.of("model", "sonnet"), restarted.agents().get("claude-code"));
        assertFalse(restarted.agents().containsKey("native"));
        assertEquals(restarted.agents(), preferences.get().agents());
    }

    @Test void restoreAppliesModelBeforeRevalidatingEffortAndPreservesBooleans() throws Exception {
        store().remember("codex", List.of(
                select("effort", "thought_level", "max", "high", "max"),
                select("model-id", "model", "deepseek", "deepseek", "sol"), bool(false)));
        List<AcpConfigOption> initial = List.of(
                select("effort", "thought_level", "high", "high"),
                select("model-id", "model", "sol", "sol", "deepseek"), bool(true));
        List<String> applied = new ArrayList<>();
        var current = new ArrayList<>(initial);
        var result = store().restore("codex", initial, (id, value) -> {
            applied.add(id);
            if ("model-id".equals(id)) {
                current.set(0, select("effort", "thought_level", "high", "high", "max"));
                current.set(1, select(id, "model", (String) value, "sol", "deepseek"));
            } else if ("effort".equals(id)) {
                current.set(0, select(id, "thought_level", (String) value, "high", "max"));
            } else current.set(2, bool((Boolean) value));
            return List.copyOf(current);
        });
        assertEquals("model-id", applied.get(0));
        assertEquals(Set.of("model-id", "effort", "fast"), new HashSet<>(applied));
        assertEquals("max", result.get(0).currentValue());
        assertEquals(false, result.get(2).currentValue());
        assertEquals(initial, store().restore("native", initial, (id, value) -> fail("another Agent's defaults leaked")));
    }

    @Test void removedAndRejectedValuesDoNotBlockDraftButTransportFailuresPropagate() throws Exception {
        store().remember("codex", List.of(
                select("model", "model", "retired", "retired"),
                select("mode", "mode", "full", "full")));
        var options = List.of(select("model", "model", "sol", "sol"),
                select("mode", "mode", "auto", "auto", "full"));
        List<String> writes = new ArrayList<>();
        assertEquals(options, store().restore("codex", options, (id, value) -> {
            writes.add(id);
            throw new ServiceException("choice disabled by policy");
        }));
        assertEquals(List.of("mode"), writes);
        assertThrows(IOException.class, () -> store().restore("codex", options, (id, value) -> {
            throw new IOException("process disconnected");
        }));
    }

    @Test void invalidAgentAndFailedWritesLeaveSavedPreferencesIntact() throws Exception {
        store().select("codex");
        assertThrows(ServiceException.class, () -> store().select("unknown"));
        assertEquals("codex", store().get().selectedAgent());
        Path blocked = home.resolve("blocked");
        Files.writeString(blocked, "file, not a directory");
        assertThrows(ServiceException.class, () -> new AgentPreferencesService(blocked.resolve("preferences.json")).select("native"));
        Files.writeString(file(), "invalid json");
        assertThrows(ServiceException.class, () -> store().select("native"));
        assertEquals("invalid json", Files.readString(file()));
    }

    @Test void controllerRemembersExistingSessionChangesButOnlySeedsFreshSessions() throws Exception {
        var preferences = store();
        try (var agents = new StubAgents()) {
            var controller = new AgentEngineController();
            inject(controller, "agents", agents);
            inject(controller, "preferences", preferences);
            controller.configure(new AgentEngineController.ConfigChange("project", "existing", "model", "deepseek"));
            assertEquals("deepseek", store().get().agents().get("codex").get("model"));
            agents.options = List.of(select("model", "model", "sol", "sol", "deepseek"));
            controller.prepare(new AgentEngineController.Prepare("project", "existing", "codex"));
            assertEquals("sol", agents.options.get(0).currentValue(), "existing conversation must keep its own choices");
            controller.configuration("project", "existing");
            assertEquals("deepseek", store().get().agents().get("codex").get("model"), "reads must not reset defaults");
            controller.prepare(new AgentEngineController.Prepare("project", null, "codex"));
            assertEquals("deepseek", agents.options.get(0).currentValue());
            // The selected Agent and per-Agent configurations are independent.
            assertNull(preferences.get().selectedAgent());
            controller.select(new AgentEngineController.Selection("claude-code"));
            assertEquals("claude-code", store().get().selectedAgent());
            assertEquals("deepseek", store().get().agents().get("codex").get("model"));
        }
    }

    @Test void rejectedExplicitChangesAndPlanTogglesDoNotOverwriteDefaults() throws Exception {
        store().remember("codex", List.of(select("model", "model", "deepseek", "deepseek")));
        try (var agents = new StubAgents()) {
            var controller = new AgentEngineController();
            inject(controller, "agents", agents);
            inject(controller, "preferences", store());
            assertThrows(ServiceException.class, () -> controller.configure(
                    new AgentEngineController.ConfigChange("project", "existing", "model", "unsupported")));
            controller.configure(new AgentEngineController.ConfigChange("project", "existing", "plan", "on"));
            assertEquals(Map.of("model", "deepseek"), store().get().agents().get("codex"));
        }
    }

    private static void inject(Object target, String name, Object value) throws Exception {
        var field = target.getClass().getDeclaredField(name);
        field.setAccessible(true);
        field.set(target, value);
    }

    private static class StubAgents extends AgentService {
        List<AcpConfigOption> options = List.of(select("model", "model", "sol", "sol", "deepseek"));
        @Override public String resolveProjectHashOrThrow(String hash) { return hash; }
        @Override public String newSession(String workspace, String name, Boolean worktree) { return name; }
        @Override public void selectSessionAgent(String workspace, String name, String requested) {}
        @Override public String sessionAgentId(String workspace, String name) { return "codex"; }
        @Override public List<AcpConfigOption> agentConfiguration(String workspace, String name, String id, Object value) {
            if ("model".equals(id)) {
                if (!options.get(0).accepts(value)) throw new ServiceException("unsupported model");
                options = List.of(select(id, "model", (String) value, "sol", "deepseek"));
            }
            return options;
        }
    }
}
