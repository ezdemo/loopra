package site.sorghum.loopra.web.service;

import com.agentclientprotocol.sdk.spec.AcpClientTransport;
import site.sorghum.loopra.web.common.ServiceException;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

/** DeepSeek Harness ships its own ACP stdio profile in the dsh CLI. */
public final class DshAcpProcess {
    private DshAcpProcess() {}

    // Some DSH plugins log with console.info during session/new. Keep ACP stdout clean
    // before importing any CLI/plugin code, while preserving the CLI's original argv.
    private static final String STDIO_PRELOAD = "data:text/javascript;base64," + java.util.Base64.getEncoder().encodeToString("""
            import { Console } from 'node:console';
            globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
            """.getBytes(java.nio.charset.StandardCharsets.UTF_8));

    public static AcpClientTransport create(Path cwd) {
        Installation install = detect();
        if (!install.available()) throw new ServiceException(503, install.reason());
        boolean windows = System.getProperty("os.name").startsWith("Windows");
        return new AcpProcessTransport(command(install),
                AcpRuntimePaths.withNodePath(install.node(), System.getenv(), windows), cwd);
    }

    static List<String> command(Installation install) {
        return List.of(install.node().toString(), "--import", STDIO_PRELOAD,
                install.script().toString(), "--profile", "acp");
    }

    public static Installation detect() {
        boolean windows = System.getProperty("os.name").startsWith("Windows");
        return detect(System.getenv(), Path.of(System.getProperty("user.home")), windows,
                System.getProperty("loopra.dsh.acp.script", System.getenv("LOOPRA_DSH_ACP_SCRIPT")),
                AcpRuntimePaths.systemRoots(windows));
    }

    static Installation detect(Map<String, String> env, Path home, boolean windows, String override, List<Path> systemRoots) {
        List<Path> roots = AcpRuntimePaths.searchRoots(env, home, systemRoots);
        Path node = AcpRuntimePaths.node(roots, env, windows);
        Path script = AcpRuntimePaths.npmBin(roots, home, windows, override, "dsh", List.of("@deepseek-ai/dsh"));
        return new Installation(node, script);
    }

    public record Installation(Path node, Path script) {
        public boolean available() { return node != null && script != null && Files.isRegularFile(script); }
        public String reason() {
            if (node == null) return "后端未找到 Node.js，请安装符合 DSH 版本要求的 Node.js";
            if (script == null || !Files.isRegularFile(script)) return "未找到 DeepSeek Harness，请安装提供 ACP profile 的 @deepseek-ai/dsh";
            return "使用本机 DSH 配置；需要提供 ACP profile 的版本";
        }
    }
}
