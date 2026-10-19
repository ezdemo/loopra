package site.sorghum.loopra.web.service;

import com.agentclientprotocol.sdk.spec.AcpClientTransport;
import org.noear.snack4.ONode;
import site.sorghum.loopra.web.common.ServiceException;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;

/** Launches the installed ACP adapter directly, without shell interpolation. */
public final class ClaudeAcpProcess {
    private ClaudeAcpProcess() {}
    public static AcpClientTransport create(Path cwd) {
        Installation install = detect();
        if (!install.available()) throw new ServiceException(503,
                install.reason());
        Map<String, String> env = processEnvironment(install, System.getenv(),
                System.getProperty("os.name").startsWith("Windows"));
        return new AcpProcessTransport(List.of(install.node().toString(), install.adapter().toString()), env, cwd);
    }

    public static Installation detect() {
        return detect(System.getenv(), Path.of(System.getProperty("user.home")),
                System.getProperty("os.name").startsWith("Windows"),
                System.getProperty("loopra.claude.acp.script", System.getenv("LOOPRA_CLAUDE_ACP_SCRIPT")));
    }

    static Installation detect(Map<String, String> env, Path home, boolean windows, String override) {
        return detect(env, home, windows, override, windows ? List.of() : List.of(
                Path.of("/opt/homebrew/bin"), Path.of("/usr/local/bin"), Path.of("/usr/bin"), Path.of("/bin")));
    }

    static Installation detect(Map<String, String> env, Path home, boolean windows, String override,
                               List<Path> systemRoots) {
        List<Path> roots = new ArrayList<>();
        addPath(roots, environment(env, "NVM_BIN"));
        addPath(roots, environment(env, "NVM_SYMLINK"));
        addPath(roots, environment(env, "NODE_HOME"));
        String path = environment(env, "PATH");
        if (path != null) for (String part : path.split(java.io.File.pathSeparator)) addPath(roots, part);
        roots.add(home.resolve(".local/bin"));
        roots.add(home.resolve(".npm-global/bin"));
        roots.add(home.resolve(".nvm/current/bin"));
        String npmPrefix = environment(env, "NPM_CONFIG_PREFIX");
        if (npmPrefix != null && !npmPrefix.isBlank()) {
            int previousSize = roots.size();
            addPath(roots, npmPrefix);
            if (roots.size() > previousSize) roots.add(roots.get(roots.size() - 1).resolve("bin"));
        }
        // Desktop launchers may omit package-manager directories from PATH.
        roots.addAll(systemRoots);
        String appData = environment(env, "APPDATA");
        if (appData != null) roots.add(Path.of(appData).resolve("npm"));
        String programFiles = environment(env, "ProgramFiles");
        if (programFiles != null) roots.add(Path.of(programFiles).resolve("nodejs"));
        Path node = executable("node", roots, windows, environment(env, "LOOPRA_NODE_EXECUTABLE"));
        if (node != null) {
            roots.add(node.toAbsolutePath().getParent());
            try { roots.add(node.toRealPath().getParent()); } catch (java.io.IOException ignored) {}
        }
        Path claude = claudeExecutable(roots, windows, environment(env, "CLAUDE_CODE_EXECUTABLE"));
        Path adapter = override == null || override.isBlank() ? null : Path.of(override);
        if (adapter == null) {
            roots.add(home.resolve(".npm-global/lib"));
            for (Path root : roots) {
                // Unix package managers may link the command to a different
                // prefix (for example Homebrew's Cellar/libexec layout).
                if (!windows) {
                    try {
                        Path command = root.resolve("claude-agent-acp").toRealPath();
                        if (Files.isRegularFile(command) && command.toString().endsWith(".js")) {
                            adapter = command; break;
                        }
                    } catch (java.io.IOException ignored) {}
                }
                for (Path base : List.of(root, root.resolve("../lib").normalize())) {
                    Path candidate = base.resolve("node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js");
                    if (Files.isRegularFile(candidate)) { adapter = candidate; break; }
                    candidate = base.resolve("node_modules/@zed-industries/claude-agent-acp/dist/index.js");
                    if (Files.isRegularFile(candidate)) { adapter = candidate; break; }
                }
                if (adapter != null) break;
            }
        }
        return new Installation(node, claude, adapter);
    }

    static Map<String, String> processEnvironment(Installation install, Map<String, String> source, boolean windows) {
        Map<String, String> env = new HashMap<>(source);
        String path = windows ? environment(source, "PATH") : source.get("PATH");
        // Keep the inherited spelling on Windows: ProcessBuilder also inherits
        // the original map, so adding PATH beside Path can leave two entries.
        String pathKey = windows ? source.keySet().stream().filter(key -> key.equalsIgnoreCase("PATH"))
                .findFirst().orElse("PATH") : "PATH";
        String claudeKey = windows ? source.keySet().stream().filter(key -> key.equalsIgnoreCase("CLAUDE_CODE_EXECUTABLE"))
                .findFirst().orElse("CLAUDE_CODE_EXECUTABLE") : "CLAUDE_CODE_EXECUTABLE";
        // The SDK starts JavaScript CLIs with "node", and Unix shebangs may
        // use /usr/bin/env. Detection alone must not leave these unresolvable.
        env.keySet().removeIf(key -> key.equals("CLAUDE_CODE_EXECUTABLE")
                || windows && (key.equalsIgnoreCase("PATH") || key.equalsIgnoreCase("CLAUDE_CODE_EXECUTABLE")));
        String separator = windows ? ";" : ":";
        env.put(pathKey, install.node().toAbsolutePath().getParent() + separator
                + install.claude().toAbsolutePath().getParent()
                + (path == null || path.isBlank() ? "" : separator + path));
        env.put(claudeKey, install.claude().toString());
        return env;
    }

    private static Path claudeExecutable(List<Path> roots, boolean windows, String override) {
        if (override != null && !override.isBlank()) {
            Path file = Path.of(override).toAbsolutePath().normalize();
            if (!Files.isRegularFile(file)) return null;
            String name = file.getFileName().toString().toLowerCase(Locale.ROOT);
            // The SDK spawns the CLI without a shell. npm's Windows shims are
            // not executables; resolve their package's declared bin instead.
            if (windows && (name.endsWith(".cmd") || name.endsWith(".ps1") || name.endsWith(".bat")
                    || name.equals("claude"))) return npmClaudeExecutable(file.getParent(), true);
            return cliFile(file, windows);
        }
        for (Path root : roots) {
            Path nativeCli = root.resolve(windows ? "claude.exe" : "claude");
            Path resolved = cliFile(nativeCli, windows);
            if (resolved != null) return resolved;
            Path npmCli = npmClaudeExecutable(root, windows);
            if (npmCli != null) return npmCli;
        }
        return null;
    }

    private static Path npmClaudeExecutable(Path root, boolean windows) {
        // npm puts global packages beside bin shims on Windows and under
        // ../lib on Unix. Read bin metadata to support both native and JS CLIs.
        for (Path base : List.of(root, root.resolve("../lib").normalize())) {
            Path pkg = base.resolve("node_modules/@anthropic-ai/claude-code").toAbsolutePath().normalize();
            Path manifest = pkg.resolve("package.json");
            if (!Files.isRegularFile(manifest)) continue;
            try {
                ONode bin = ONode.ofJson(Files.readString(manifest)).get("bin");
                if (bin.isObject()) bin = bin.get("claude");
                if (!bin.isString() || bin.getString().isBlank()) continue;
                Path cli = pkg.resolve(bin.getString()).normalize();
                if (cli.startsWith(pkg)) {
                    Path resolved = cliFile(cli, windows);
                    if (resolved != null) return resolved;
                }
            } catch (Exception ignored) {
                // A broken package in one prefix must not hide another install.
            }
        }
        return null;
    }

    private static Path cliFile(Path file, boolean windows) {
        try {
            Path resolved = file.toRealPath();
            if (!Files.isRegularFile(resolved)) return null;
            // Preserve the actual .js suffix so the SDK invokes Node instead
            // of treating an extensionless npm symlink as a native executable.
            boolean script = List.of(".js", ".mjs", ".ts", ".tsx", ".jsx").stream()
                    .anyMatch(suffix -> resolved.toString().endsWith(suffix));
            return windows || script || Files.isExecutable(resolved) ? resolved : null;
        } catch (java.io.IOException ignored) { return null; }
    }

    private static Path executable(String name, List<Path> roots, boolean windows, String override) {
        if (override != null && !override.isBlank()) {
            Path file = Path.of(override);
            return Files.isRegularFile(file) && (windows || Files.isExecutable(file)) ? file : null;
        }
        for (Path root : roots) {
            Path file = root.resolve(name + (windows ? ".exe" : ""));
            if (Files.isRegularFile(file) && (windows || Files.isExecutable(file))) return file.toAbsolutePath().normalize();
        }
        return null;
    }

    private static String environment(Map<String, String> env, String key) {
        // System.getenv(String) is case-insensitive on Windows; getenv()'s Map need not be.
        return env.entrySet().stream().filter(entry -> entry.getKey().equalsIgnoreCase(key))
                .map(Map.Entry::getValue).findFirst().orElse(null);
    }

    private static void addPath(List<Path> paths, String value) {
        if (value == null || value.isBlank()) return;
        value = value.trim();
        if (value.startsWith("\"") && value.endsWith("\"")) value = value.substring(1, value.length() - 1);
        try { paths.add(Path.of(value)); } catch (java.nio.file.InvalidPathException ignored) {}
    }

    public record Installation(Path node, Path claude, Path adapter) {
        public boolean available() { return node != null && claude != null && adapter != null && Files.isRegularFile(adapter); }
        public String reason() {
            if (node == null) return "后端未找到 Node.js，请检查后端进程的 Path 或 NVM_SYMLINK";
            if (claude == null) return "后端未找到 Claude Code，可用 CLAUDE_CODE_EXECUTABLE 指定路径";
            if (adapter == null || !Files.isRegularFile(adapter)) return "未找到 ACP 适配器，请安装 @agentclientprotocol/claude-agent-acp";
            return "使用本机 Claude 登录和配置";
        }
    }
}
