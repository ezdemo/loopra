package site.sorghum.loopra.web.service;

import com.agentclientprotocol.sdk.spec.AcpClientTransport;
import site.sorghum.loopra.web.common.ServiceException;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

/** The maintained npm adapter includes a compatible Codex CLI and owns its app-server. */
public final class CodexAcpProcess {
    private CodexAcpProcess() {}

    public static AcpClientTransport create(Path cwd) {
        Installation install = detect();
        if (!install.available()) throw new ServiceException(503, install.reason());
        boolean windows = System.getProperty("os.name").startsWith("Windows");
        return new AcpProcessTransport(List.of(install.node().toString(), install.adapter().toString()),
                AcpRuntimePaths.withNodePath(install.node(), System.getenv(), windows), cwd);
    }

    public static Installation detect() {
        boolean windows = System.getProperty("os.name").startsWith("Windows");
        return detect(System.getenv(), Path.of(System.getProperty("user.home")), windows,
                System.getProperty("loopra.codex.acp.script", System.getenv("LOOPRA_CODEX_ACP_SCRIPT")),
                AcpRuntimePaths.systemRoots(windows));
    }

    static Installation detect(Map<String, String> env, Path home, boolean windows, String override,
                               List<Path> systemRoots) {
        List<Path> roots = AcpRuntimePaths.searchRoots(env, home, systemRoots);
        Path node = AcpRuntimePaths.node(roots, env, windows);
        Path adapter = AcpRuntimePaths.adapter(roots, home, windows, override, "codex-acp",
                List.of("@agentclientprotocol/codex-acp"));
        return new Installation(node, adapter);
    }

    public record Installation(Path node, Path adapter) {
        public boolean available() { return node != null && adapter != null && Files.isRegularFile(adapter); }
        public String reason() {
            if (node == null) return "后端未找到 Node.js，请检查后端进程的 Path 或 NVM_SYMLINK";
            if (adapter == null || !Files.isRegularFile(adapter))
                return "未找到 Codex ACP 适配器，请安装 @agentclientprotocol/codex-acp";
            return "使用本机 Codex 登录和配置";
        }
    }
}
