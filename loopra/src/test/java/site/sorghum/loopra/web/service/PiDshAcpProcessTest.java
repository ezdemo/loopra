package site.sorghum.loopra.web.service;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.noear.snack4.ONode;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class PiDshAcpProcessTest {
    @TempDir Path home;

    @Test void piRequiresBothCliAndAdapterAndPassesDiscoveredCliToChild() throws Exception {
        Path bin = node("Node With Spaces", true);
        Path prefix = home.resolve("AppData/Roaming/npm");
        Path script = npmBin(prefix, "pi-acp", "pi-acp", "dist/index.js");
        Map<String, String> env = Map.of("NVM_SYMLINK", bin.toString(), "APPDATA", home.resolve("AppData/Roaming").toString(),
                "Path", "inherited", "PI_CODING_AGENT_DIR", "custom-config");
        var missing = PiAcpProcess.detect(env, home, true, null, List.of());
        assertFalse(missing.available());
        assertTrue(missing.reason().contains("Pi CLI"));
        Path pi = Files.writeString(prefix.resolve("pi.cmd"), "npm launcher");
        var install = PiAcpProcess.detect(env, home, true, null, List.of());
        assertTrue(install.available(), install.reason());
        assertEquals(script, install.adapter());
        assertEquals(pi, install.pi());
        var child = PiAcpProcess.environment(install, env, true);
        assertEquals(pi.toString(), child.get("PI_ACP_PI_COMMAND"));
        assertEquals("custom-config", child.get("PI_CODING_AGENT_DIR"));
        assertEquals(bin + ";inherited", child.get("Path"));
        assertEquals(1, child.keySet().stream().filter(key -> key.equalsIgnoreCase("PATH")).count());
    }

    @Test void piAcceptsExplicitCliAndAdapterOutsidePath() throws Exception {
        Path bin = node("node", true);
        Path pi = Files.writeString(home.resolve("pi custom.exe"), "");
        Path script = Files.writeString(home.resolve("adapter custom.mjs"), "");
        var env = Map.of("NODE_HOME", bin.toString(), "PI_ACP_PI_COMMAND", pi.toString());
        assertTrue(PiAcpProcess.detect(env, home, true, script.toString(), List.of()).available());
        assertFalse(PiAcpProcess.detect(env, home, true, home.resolve("missing.js").toString(), List.of()).available());
        Files.delete(pi);
        assertFalse(PiAcpProcess.detect(env, home, true, script.toString(), List.of()).available());
    }

    @Test void dshUsesDeclaredLibBinAndAcpProfileWithLiteralArguments() throws Exception {
        Path bin = node("Node With Spaces", true);
        Path script = npmBin(bin, "@deepseek-ai/dsh", "dsh", "lib/bin.js");
        var install = DshAcpProcess.detect(Map.of("Path", bin.toString()), home, true, null, List.of());
        assertTrue(install.available(), install.reason());
        assertEquals(script, install.script());
        var command = DshAcpProcess.command(install);
        assertEquals(bin.resolve("node.exe").toString(), command.get(0));
        assertEquals(List.of(script.toString(), "--profile", "acp"), command.subList(3, command.size()));
    }

    @Test @org.junit.jupiter.api.Timeout(20)
    void dshBootstrapRedirectsPluginLogsAndPreservesProtocolStdoutAndLiteralArguments() throws Exception {
        boolean windows = System.getProperty("os.name").startsWith("Windows");
        var roots = AcpRuntimePaths.searchRoots(System.getenv(), Path.of(System.getProperty("user.home")), AcpRuntimePaths.systemRoots(windows));
        Path node = AcpRuntimePaths.node(roots, System.getenv(), windows);
        org.junit.jupiter.api.Assumptions.assumeTrue(node != null, "Node.js is needed to verify the DSH launcher");
        Path script = Files.writeString(home.resolve("DSH plugin with spaces.mjs"), """
                console.info('[llm-deepseek-account] model listing loaded 2 models');
                console.log('plugin log');
                console.debug('plugin debug');
                console.warn('plugin warning');
                process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { argv: process.argv.slice(1), main: import.meta.main ?? true } }) + '\\n');
                """);
        Path stderr = home.resolve("stderr.txt");
        Process process = new ProcessBuilder(DshAcpProcess.command(new DshAcpProcess.Installation(node, script)))
                .redirectError(stderr.toFile()).start();
        try {
            assertTrue(process.waitFor(10, java.util.concurrent.TimeUnit.SECONDS));
            assertEquals(0, process.exitValue(), Files.readString(stderr));
            var stdout = new String(process.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8).lines().toList();
            assertEquals(1, stdout.size(), "Only the JSON-RPC frame belongs on stdout");
            assertTrue(ONode.ofJson(stdout.get(0)).get("result").get("main").getBoolean(), "The CLI must remain the entry module");
            var args = ONode.ofJson(stdout.get(0)).get("result").get("argv");
            assertEquals(script.toString(), args.get(0).getString());
            assertEquals("--profile", args.get(1).getString());
            assertEquals("acp", args.get(2).getString());
            String diagnostics = Files.readString(stderr);
            for (String expected : List.of("model listing loaded", "plugin log", "plugin debug", "plugin warning")) {
                assertTrue(diagnostics.contains(expected), diagnostics);
            }
        } finally { process.destroyForcibly(); }
    }

    @Test void unixPrefixAndMjsBinsAreSupportedWithoutWindowsShims() throws Exception {
        Path bin = node("prefix/bin", false);
        Path script = npmBin(home.resolve("prefix/lib"), "@deepseek-ai/dsh", "dsh", "lib/cli.mjs");
        var install = DshAcpProcess.detect(Map.of("NPM_CONFIG_PREFIX", home.resolve("prefix").toString()), home, false, null, List.of());
        assertTrue(install.available(), install.reason());
        assertEquals(script, install.script());
    }

    @Test void brokenMetadataAndOrphanShimsDoNotHideAnotherInstallation() throws Exception {
        Path bin = node("bin", true);
        Files.writeString(bin.resolve("dsh.cmd"), "orphan");
        Path script = npmBin(bin, "@deepseek-ai/dsh", "dsh", "lib/bin.js");
        Path manifest = script.getParent().getParent().resolve("package.json");
        Files.writeString(manifest, "{broken");
        assertFalse(DshAcpProcess.detect(Map.of("Path", bin.toString()), home, true, null, List.of()).available());
        Path valid = npmBin(home.resolve(".npm-global/lib"), "@deepseek-ai/dsh", "dsh", "lib/bin.js");
        assertEquals(valid, DshAcpProcess.detect(Map.of("Path", bin.toString()), home, true, null, List.of()).script());
        Files.writeString(manifest, ONode.serialize(Map.of("bin", Map.of("dsh", "../../outside.js"))));
        Files.writeString(script.getParent().getParent().resolve("../../outside.js").normalize(), "");
        assertEquals(valid, DshAcpProcess.detect(Map.of("Path", bin.toString()), home, true, null, List.of()).script());
    }

    @Test void dshExplicitBuildEntryAndProviderRegistrationAreAvailable() throws Exception {
        Path bin = node("bin", true);
        Path script = Files.writeString(home.resolve("built dsh.js"), "");
        assertTrue(DshAcpProcess.detect(Map.of("NODE_HOME", bin.toString()), home, true, script.toString(), List.of()).available());
        assertFalse(DshAcpProcess.detect(Map.of("NODE_HOME", bin.toString()), home, true, home.resolve("missing.js").toString(), List.of()).available());
        assertTrue(ExternalAcpProviders.isExternal("pi"));
        assertTrue(ExternalAcpProviders.isExternal("dsh"));
        assertEquals("Pi", ExternalAcpProviders.require("pi").name());
        assertEquals("DeepSeek Harness", ExternalAcpProviders.require("dsh").name());
    }

    private Path node(String directory, boolean windows) throws Exception {
        Path bin = Files.createDirectories(home.resolve(directory));
        Path node = Files.createFile(bin.resolve(windows ? "node.exe" : "node"));
        if (!windows) assertTrue(node.toFile().setExecutable(true));
        return bin;
    }

    private Path npmBin(Path prefix, String name, String command, String entry) throws Exception {
        Path pkg = Files.createDirectories(prefix.resolve("node_modules").resolve(name));
        Files.writeString(pkg.resolve("package.json"), ONode.serialize(Map.of("bin", Map.of(command, entry))));
        Path script = pkg.resolve(entry);
        Files.createDirectories(script.getParent());
        return Files.writeString(script, "");
    }
}
