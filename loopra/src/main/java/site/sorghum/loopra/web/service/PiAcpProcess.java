package site.sorghum.loopra.web.service;

import com.agentclientprotocol.sdk.spec.AcpClientTransport;
import site.sorghum.loopra.web.common.ServiceException;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** pi-acp bridges ACP to a separately installed pi --mode rpc process. */
public final class PiAcpProcess {
    private PiAcpProcess() {}

    public static AcpClientTransport create(Path cwd) {
        Installation install = detect();
        if (!install.available()) throw new ServiceException(503, install.reason());
        boolean windows = System.getProperty("os.name").startsWith("Windows");
        return new AcpProcessTransport(List.of(install.node().toString(), install.adapter().toString()),
                environment(install, System.getenv(), windows), cwd);
    }

    public static Installation detect() {
        boolean windows = System.getProperty("os.name").startsWith("Windows");
        return detect(System.getenv(), Path.of(System.getProperty("user.home")), windows,
                System.getProperty("loopra.pi.acp.script", System.getenv("LOOPRA_PI_ACP_SCRIPT")),
                AcpRuntimePaths.systemRoots(windows));
    }

    static Installation detect(Map<String, String> env, Path home, boolean windows, String override, List<Path> systemRoots) {
        List<Path> roots = AcpRuntimePaths.searchRoots(env, home, systemRoots);
        Path node = AcpRuntimePaths.node(roots, env, windows);
        Path adapter = AcpRuntimePaths.npmBin(roots, home, windows, override, "pi-acp", List.of("pi-acp"));
        String command = AcpRuntimePaths.environment(env, "PI_ACP_PI_COMMAND");
        Path pi = null;
        if (command != null && !command.isBlank() && Path.of(command).isAbsolute()) {
            pi = executable(Path.of(command), windows);
        } else {
            List<String> names = command != null && !command.isBlank() ? List.of(command)
                    : windows ? List.of("pi.exe", "pi.cmd", "pi.bat") : List.of("pi");
            for (Path root : roots) {
                for (String name : names) {
                    pi = executable(root.resolve(name), windows);
                    if (pi != null) break;
                }
                if (pi != null) break;
            }
        }
        return new Installation(node, pi, adapter);
    }

    private static Path executable(Path path, boolean windows) {
        return Files.isRegularFile(path) && (windows || Files.isExecutable(path)) ? path.toAbsolutePath().normalize() : null;
    }

    static Map<String, String> environment(Installation install, Map<String, String> source, boolean windows) {
        Map<String, String> env = new HashMap<>(AcpRuntimePaths.withNodePath(install.node(), source, windows));
        // NVM/AppData fallbacks may be absent from the inherited desktop PATH.
        if (windows) env.keySet().removeIf(key -> key.equalsIgnoreCase("PI_ACP_PI_COMMAND"));
        env.put("PI_ACP_PI_COMMAND", install.pi().toString());
        return env;
    }

    public record Installation(Path node, Path pi, Path adapter) {
        public boolean available() { return node != null && pi != null && adapter != null && Files.isRegularFile(adapter); }
        public String reason() {
            if (node == null) return "后端未找到 Node.js，请安装 Node.js 22+";
            if (pi == null) return "未找到 Pi CLI，请安装 @earendil-works/pi-coding-agent，或设置 PI_ACP_PI_COMMAND";
            if (adapter == null || !Files.isRegularFile(adapter)) return "未找到 Pi ACP 适配器，请安装 pi-acp";
            return "使用本机 Pi 登录和配置；pi-acp 暂不转发工作台 MCP";
        }
    }
}
