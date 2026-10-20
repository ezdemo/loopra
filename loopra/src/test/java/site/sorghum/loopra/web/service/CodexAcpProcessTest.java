package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class CodexAcpProcessTest {
    @TempDir Path home;

    @Test void windowsNpmInstallUsesBundledCodexWithoutRequiringAnotherCli() throws Exception {
        Path bin = node("Node With Spaces", true);
        Path adapter = adapter(bin);
        var install = detect(Map.of("Path", bin.toString()), true, null);
        assertTrue(install.available(), install.reason());
        assertEquals(adapter, install.adapter());
        assertEquals(bin.resolve("node.exe"), install.node());
        assertFalse(Files.exists(bin.resolve("codex.exe")));
    }

    @Test void desktopNvmNodeAndAppDataNpmPrefixAreDetectedTogether() throws Exception {
        Path bin = node("nvm/current", true);
        Path appData = home.resolve("AppData/Roaming");
        Path script = adapter(appData.resolve("npm"));
        var install = detect(Map.of("NVM_SYMLINK", bin.toString(), "APPDATA", appData.toString()), true, null);
        assertTrue(install.available(), install.reason());
        assertEquals(script, install.adapter());
    }

    @Test void unixNpmPrefixAndHomeGlobalLayoutAreSupported() throws Exception {
        Path bin = node("prefix/bin", false);
        Path script = adapter(home.resolve("prefix/lib"));
        var install = detect(Map.of("NPM_CONFIG_PREFIX", home.resolve("prefix").toString()), false, null);
        assertTrue(install.available(), install.reason());
        assertEquals(bin.resolve("node"), install.node());
        assertEquals(script, install.adapter());
        Files.delete(script);
        Path homeScript = adapter(home.resolve(".npm-global/lib"));
        assertEquals(homeScript, detect(Map.of("NODE_HOME", bin.toString()), false, null).adapter());
    }

    @Test void explicitNodeAndAdapterLocationsWorkOutsideTheSearchPath() throws Exception {
        Path bin = node("custom runtime", true);
        Path script = Files.writeString(home.resolve("custom adapter.js"), "");
        var install = detect(Map.of("LOOPRA_NODE_EXECUTABLE", bin.resolve("node.exe").toString()), true, script.toString());
        assertTrue(install.available(), install.reason());
        assertEquals(script, install.adapter());
        assertFalse(detect(Map.of("NODE_HOME", bin.toString()), true, home.resolve("missing.js").toString()).available());
    }

    @Test void orphanCommandShimsAndArchivedAdaptersAreNotAccepted() throws Exception {
        Path bin = node("bin", true);
        Files.writeString(bin.resolve("codex-acp.cmd"), "orphan shim");
        Path archived = bin.resolve("node_modules/@zed-industries/codex-acp/dist/index.js");
        Files.createDirectories(archived.getParent());
        Files.createFile(archived);
        var install = detect(Map.of("PATH", bin.toString()), true, null);
        assertFalse(install.available());
        assertTrue(install.reason().contains("@agentclientprotocol/codex-acp"));
        assertFalse(detect(Map.of(), true, null).available());
    }

    @Test void childEnvironmentKeepsCodexSettingsAndOneWindowsPathEntry() throws Exception {
        Path bin = node("custom node", true);
        Map<String, String> env = AcpRuntimePaths.withNodePath(bin.resolve("node.exe"),
                Map.of("Path", "existing", "CODEX_HOME", "custom-home", "CODEX_PATH", "custom-cli", "MODEL_PROVIDER", "custom"), true);
        assertEquals(1, env.keySet().stream().filter(key -> key.equalsIgnoreCase("PATH")).count());
        assertEquals(bin + ";existing", env.get("Path"));
        assertEquals("custom-home", env.get("CODEX_HOME"));
        assertEquals("custom-cli", env.get("CODEX_PATH"));
        assertEquals("custom", env.get("MODEL_PROVIDER"));
        assertFalse(env.containsKey("INITIAL_AGENT_MODE"), "Loopra must not broaden the Agent's permissions");
    }

    private CodexAcpProcess.Installation detect(Map<String, String> env, boolean windows, String override) {
        return CodexAcpProcess.detect(env, home, windows, override, List.of());
    }

    private Path node(String directory, boolean windows) throws Exception {
        Path bin = Files.createDirectories(home.resolve(directory));
        Path node = Files.createFile(bin.resolve(windows ? "node.exe" : "node"));
        if (!windows) assertTrue(node.toFile().setExecutable(true));
        return bin;
    }

    private Path adapter(Path prefix) throws Exception {
        Path script = prefix.resolve("node_modules/@agentclientprotocol/codex-acp/dist/index.js");
        Files.createDirectories(script.getParent());
        return Files.createFile(script);
    }
}
