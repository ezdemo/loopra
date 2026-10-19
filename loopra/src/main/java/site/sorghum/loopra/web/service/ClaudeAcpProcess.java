package site.sorghum.loopra.web.service;

import com.agentclientprotocol.sdk.spec.AcpClientTransport;
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
                "请安装 Claude Code 和 ACP 适配器：npm install -g @agentclientprotocol/claude-agent-acp@0.93.0");
        Map<String, String> env = new HashMap<>(System.getenv());
        env.put("CLAUDE_CODE_EXECUTABLE", install.claude().toString());
        return new AcpProcessTransport(List.of(install.node().toString(), install.adapter().toString()), env, cwd);
    }

    public static Installation detect() {
        return detect(System.getenv(), Path.of(System.getProperty("user.home")),
                System.getProperty("os.name").toLowerCase(Locale.ROOT).contains("win"),
                System.getProperty("loopra.claude.acp.script", System.getenv("LOOPRA_CLAUDE_ACP_SCRIPT")));
    }

    static Installation detect(Map<String, String> env, Path home, boolean windows, String override) {
        List<Path> roots = new ArrayList<>();
        roots.add(home.resolve(".local/bin"));
        if (!windows) {
            // GUI-launched backends (IDE run configs, desktop shells) inherit
            // launchd's minimal PATH, which omits package-manager bin dirs.
            roots.add(Path.of("/opt/homebrew/bin"));
            roots.add(Path.of("/usr/local/bin"));
        }
        addPath(roots, environment(env, "NVM_SYMLINK"));
        addPath(roots, environment(env, "NODE_HOME"));
        String appData = environment(env, "APPDATA");
        if (appData != null) roots.add(Path.of(appData).resolve("npm"));
        String programFiles = environment(env, "ProgramFiles");
        if (programFiles != null) roots.add(Path.of(programFiles).resolve("nodejs"));
        String path = environment(env, "PATH");
        if (path != null) for (String part : path.split(java.io.File.pathSeparator)) addPath(roots, part);
        Path node = executable("node", roots, windows, environment(env, "LOOPRA_NODE_EXECUTABLE"));
        Path claude = executable("claude", roots, windows, environment(env, "CLAUDE_CODE_EXECUTABLE"));
        Path adapter = override == null || override.isBlank() ? null : Path.of(override);
        if (adapter == null) {
            if (node != null) roots.add(node.getParent());
            roots.add(home.resolve(".npm-global/lib"));
            for (Path root : roots) {
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

    private static Path executable(String name, List<Path> roots, boolean windows, String override) {
        if (override != null && !override.isBlank()) return Files.isRegularFile(Path.of(override)) ? Path.of(override) : null;
        for (Path root : roots) {
            Path file = root.resolve(name + (windows ? ".exe" : ""));
            if (Files.isRegularFile(file)) return file.toAbsolutePath().normalize();
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
