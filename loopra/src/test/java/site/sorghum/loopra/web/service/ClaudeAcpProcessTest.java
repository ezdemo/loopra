package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledOnOs;
import org.junit.jupiter.api.condition.OS;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import java.nio.file.*;
import java.util.Map;
import java.util.List;
import java.util.concurrent.TimeUnit;
import static org.junit.jupiter.api.Assertions.*;

class ClaudeAcpProcessTest {
    @TempDir Path home;
    @Test void windowsPathKeyIsCaseInsensitiveAndSupportsNvm() throws Exception {
        Path bin = Files.createDirectories(home.resolve("node with spaces"));
        Files.createFile(bin.resolve("node.exe"));
        Path claude = home.resolve(".local/bin/claude.exe");
        Files.createDirectories(claude.getParent()); Files.createFile(claude);
        Path adapter = bin.resolve("node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js");
        Files.createDirectories(adapter.getParent()); Files.createFile(adapter);
        assertTrue(detect(Map.of("Path", "\"" + bin + "\""), home, true, null).available());
        assertTrue(detect(Map.of("nvm_symlink", bin.toString()), home, true, null).available());
        assertFalse(detect(Map.of(), home, true, null).available());
        assertTrue(detect(Map.of(), home, true, null).reason().contains("Node.js"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"bin/claude.exe", "cli.js"})
    void windowsNpmInstallResolvesRealCliInsteadOfCmdShim(String entry) throws Exception {
        Path bin = runtime(home.resolve("npm prefix with spaces"));
        Path cli = npmCli(bin, entry);
        Files.writeString(bin.resolve("claude.cmd"), "@echo off\r\n");
        var install = detect(Map.of("Path", bin.toString()), home, true, null);
        assertTrue(install.available(), install.reason());
        assertEquals(cli, install.claude());
    }

    @ParameterizedTest
    @ValueSource(strings = {"claude.cmd", "claude.ps1", "claude"})
    void explicitNpmShimAlsoResolvesToThePackageEntry(String shim) throws Exception {
        Path bin = runtime(home.resolve("npm"));
        Path cli = npmCli(bin, "bin/claude.exe");
        Path wrapper = Files.writeString(bin.resolve(shim), "npm shim");
        var install = detect(Map.of("NVM_SYMLINK", bin.toString(),
                "CLAUDE_CODE_EXECUTABLE", wrapper.toString()), home, true, null);
        assertTrue(install.available(), install.reason());
        assertEquals(cli, install.claude());
    }

    @Test void appDataNpmPrefixIsFoundWithoutBeingOnPath() throws Exception {
        Path node = runtime(home.resolve("node"));
        Path appData = Files.createDirectories(home.resolve("AppData/Roaming"));
        Path cli = npmCli(appData.resolve("npm"), "bin/claude.exe");
        var install = detect(Map.of("NODE_HOME", node.toString(),
                "APPDATA", appData.toString()), home, true, null);
        assertTrue(install.available(), install.reason());
        assertEquals(cli, install.claude());
    }

    @Test void explicitNodeLocationAlsoFindsItsGlobalPackages() throws Exception {
        Path bin = runtime(home.resolve("node"));
        Path cli = npmCli(bin, "cli.js");
        var install = detect(Map.of("LOOPRA_NODE_EXECUTABLE", bin.resolve("node.exe").toString()),
                home, true, null);
        assertTrue(install.available(), install.reason());
        assertEquals(cli, install.claude());
    }

    @Test void unixNpmLibLayoutAndStringBinMetadataAreSupported() throws Exception {
        Path bin = Files.createDirectories(home.resolve("prefix/bin"));
        Files.createFile(bin.resolve("node")).toFile().setExecutable(true);
        Path cli = npmCli(home.resolve("prefix/lib"), "cli.js");
        Path adapter = home.resolve("prefix/lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js");
        Files.createDirectories(adapter.getParent()); Files.createFile(adapter);
        Files.writeString(cli.getParent().resolve("package.json"), "{\"bin\":\"cli.js\"}");
        var install = detect(Map.of("PATH", bin.toString()), home, false, null);
        assertTrue(install.available(), install.reason());
        assertEquals(cli, install.claude());
    }

    @Test void nativeInstallStillTakesPrecedenceOverNpmInTheSameDirectory() throws Exception {
        Path bin = runtime(home.resolve("node"));
        Path nativeCli = Files.createFile(bin.resolve("claude.exe"));
        npmCli(bin, "cli.js");
        assertEquals(nativeCli.toRealPath(), detect(Map.of("Path", bin.toString()), home, true, null).claude());
    }

    @Test void brokenPackageDoesNotHideAnotherInstallation() throws Exception {
        Path bin = runtime(home.resolve("broken"));
        Path brokenCli = npmCli(bin, "bin/claude.exe");
        Files.writeString(brokenCli.getParent().getParent().resolve("package.json"), "invalid json");
        Path other = Files.createDirectories(home.resolve("other"));
        Path cli = npmCli(other, "cli.js");
        var install = detect(Map.of("NVM_SYMLINK", bin.toString(), "NODE_HOME", other.toString()),
                home, true, null);
        assertTrue(install.available(), install.reason());
        assertEquals(cli, install.claude());
    }

    @Test void orphanShimOrMissingPackageEntryMustNotReportAvailable() throws Exception {
        Path bin = runtime(home.resolve("node"));
        Files.writeString(bin.resolve("claude.cmd"), "npm shim");
        assertNull(detect(Map.of("Path", bin.toString()), home, true, null).claude());
        Path cli = npmCli(bin, "cli.js");
        Files.delete(cli);
        assertNull(detect(Map.of("Path", bin.toString()), home, true, null).claude());
    }

    @ParameterizedTest
    @ValueSource(strings = {"opt/homebrew/bin", "usr/local/bin"})
    void macHomebrewFallbackWorksWithoutDesktopPath(String layout) throws Exception {
        Path bin = Files.createDirectories(home.resolve(layout));
        Files.createFile(bin.resolve("node")).toFile().setExecutable(true);
        Path cli = npmCli(bin.resolve("../lib").normalize(), "cli.js");
        Path adapter = bin.resolve("../lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js").normalize();
        Files.createDirectories(adapter.getParent()); Files.createFile(adapter);
        var install = ClaudeAcpProcess.detect(Map.of(), home, false, null, List.of(bin));
        assertTrue(install.available(), install.reason());
        assertEquals(cli, install.claude());
    }

    @Test void unixNvmBinAndConfiguredNpmPrefixWorkWithoutPath() throws Exception {
        Path bin = Files.createDirectories(home.resolve(".nvm/versions/node/v22.0.0/bin"));
        Files.createFile(bin.resolve("node")).toFile().setExecutable(true);
        Path prefix = home.resolve("custom global prefix");
        Path cli = npmCli(prefix.resolve("lib"), "cli.js");
        Path adapter = prefix.resolve("lib/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js");
        Files.createDirectories(adapter.getParent()); Files.createFile(adapter);
        var install = detect(Map.of("NVM_BIN", bin.toString(), "NPM_CONFIG_PREFIX", prefix.toString()),
                home, false, null);
        assertTrue(install.available(), install.reason());
        assertEquals(cli, install.claude());
    }

    @Test @EnabledOnOs({OS.LINUX, OS.MAC})
    void unixNpmSymlinksResolveToRealScriptsAndHandleBrokenLinks() throws Exception {
        Path bin = Files.createDirectories(home.resolve("prefix/bin"));
        Files.createFile(bin.resolve("node")).toFile().setExecutable(true);
        Path cli = npmCli(home.resolve("prefix/lib"), "cli.js");
        Path shim = Files.createSymbolicLink(bin.resolve("claude"), cli);
        // Adapter can live outside Node's prefix, as with Homebrew libexec.
        Path adapter = Files.createDirectories(home.resolve("Cellar/adapter/libexec")).resolve("index.js");
        Files.createFile(adapter);
        Files.createSymbolicLink(bin.resolve("claude-agent-acp"), adapter);
        var install = detect(Map.of("PATH", bin.toString()), home, false, null);
        assertTrue(install.available(), install.reason());
        assertEquals(cli, install.claude());
        assertEquals(adapter.toRealPath(), install.adapter());
        assertEquals(cli, detect(Map.of("PATH", bin.toString(), "CLAUDE_CODE_EXECUTABLE", shim.toString()),
                home, false, null).claude());
        Files.delete(cli);
        assertNull(detect(Map.of("PATH", bin.toString()), home, false, null).claude());
    }

    @Test @EnabledOnOs({OS.LINUX, OS.MAC})
    void unixNativeInstallationResolvesSymlinkAndRequiresExecutePermission() throws Exception {
        Path bin = Files.createDirectories(home.resolve(".local/bin"));
        Path nativeCli = Files.createDirectories(home.resolve(".local/share/claude/versions")).resolve("1.0.0");
        Files.createFile(nativeCli);
        assertTrue(nativeCli.toFile().setExecutable(true));
        Files.createSymbolicLink(bin.resolve("claude"), nativeCli);
        assertEquals(nativeCli.toRealPath(), detect(Map.of(), home, false, null).claude());
        assertTrue(nativeCli.toFile().setExecutable(false, false));
        assertNull(detect(Map.of(), home, false, null).claude());
    }

    @Test void windowsChildEnvironmentHasOnePathAndKeepsExistingTools() {
        Path node = home.resolve("node with spaces/node.exe");
        Path cli = home.resolve("npm/cli.js");
        var env = ClaudeAcpProcess.processEnvironment(new ClaudeAcpProcess.Installation(node, cli, null),
                Map.of("Path", "C:\\Windows\\System32", "claude_code_executable", "stale", "KEEP", "value"), true);
        assertEquals(node.getParent() + ";" + cli.getParent() + ";C:\\Windows\\System32", env.get("Path"));
        assertFalse(env.containsKey("PATH"));
        assertFalse(env.containsKey("CLAUDE_CODE_EXECUTABLE"));
        assertEquals(cli.toString(), env.get("claude_code_executable"));
        assertEquals("value", env.get("KEEP"));
    }

    @Test @EnabledOnOs({OS.LINUX, OS.MAC})
    void unixChildCanActuallyLaunchNodeWithNoInheritedPath() throws Exception {
        Path bin = Files.createDirectories(home.resolve("node with spaces/bin"));
        Path node = Files.writeString(bin.resolve("node"), "#!/bin/sh\nprintf 'NODE_FROM_DETECTED_PATH:%s' \"$1\"\n");
        assertTrue(node.toFile().setExecutable(true));
        Path cli = home.resolve("cli.js");
        var env = ClaudeAcpProcess.processEnvironment(new ClaudeAcpProcess.Installation(node, cli, null), Map.of(), false);
        var builder = new ProcessBuilder("/usr/bin/env", "node", "argument with spaces");
        builder.environment().clear(); builder.environment().putAll(env);
        Process process = builder.start();
        try {
            assertTrue(process.waitFor(5, TimeUnit.SECONDS));
            assertEquals(0, process.exitValue());
            assertEquals("NODE_FROM_DETECTED_PATH:argument with spaces", new String(process.getInputStream().readAllBytes()));
        } finally { if (process.isAlive()) process.destroyForcibly(); }
    }

    private static ClaudeAcpProcess.Installation detect(Map<String, String> env, Path home, boolean windows, String override) {
        // Fixture tests must not accidentally pick up the host's real installs.
        return ClaudeAcpProcess.detect(env, home, windows, override, List.of());
    }

    private Path runtime(Path bin) throws Exception {
        Files.createDirectories(bin);
        Files.createFile(bin.resolve("node.exe"));
        Path adapter = bin.resolve("node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js");
        Files.createDirectories(adapter.getParent());
        Files.createFile(adapter);
        return bin;
    }

    private Path npmCli(Path prefix, String entry) throws Exception {
        Path pkg = prefix.resolve("node_modules/@anthropic-ai/claude-code");
        Path cli = pkg.resolve(entry);
        Files.createDirectories(cli.getParent());
        Files.createFile(cli);
        Files.writeString(pkg.resolve("package.json"), "{\"bin\":{\"claude\":\"" + entry + "\"}}");
        return cli.toRealPath();
    }
}
