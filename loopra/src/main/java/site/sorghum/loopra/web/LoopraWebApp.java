package site.sorghum.loopra.web;

import com.agentclientprotocol.sdk.agent.transport.StdioAcpAgentTransport;
import org.noear.solon.Solon;
import org.noear.solon.annotation.Import;
import org.noear.solon.annotation.SolonMain;
import site.sorghum.loopra.bin.acp.AcpBootstrap;
import site.sorghum.loopra.web.common.WebAccessFilter;

import java.util.Arrays;

/**
 * Loopra Web 入口 —— 通过 REST API 暴露全部 Agent 功能。
 * <p>
 * 启动参数：
 * <ul>
 *   <li><code>--loopra.acp=true</code> 启用 ACP 协议支持（stdio 模式）</li>
 *   <li><code>--loopra.acp.ws.port=8765</code> 启用 ACP WebSocket 模式（需 acp-websocket-jetty）</li>
 * </ul>
 * </p>
 *
 * @author Sorghum
 */
@Import(scanPackages = {"site.sorghum.loopra"})
@SolonMain
public class LoopraWebApp {

    public static void main(String[] args) {
        // Select protocol-only stdio before Solon or any banner writes to stdout.
        boolean stdio = Arrays.asList(args).contains("--loopra.acp=true")
                && Arrays.stream(args).noneMatch(arg -> {
                    String prefix = "--loopra.acp.ws.port=";
                    if (!arg.startsWith(prefix)) return false;
                    try { return Integer.parseInt(arg.substring(prefix.length())) > 0; }
                    catch (NumberFormatException ignored) { return false; }
                });
        if (stdio) {
            try { site.sorghum.loopra.bin.acp.LoopraAcpMain.main(args); }
            catch (Exception exception) { throw new IllegalStateException("ACP stdio failed", exception); }
            return;
        }
        System.out.println(
                "args:" + Arrays.toString(args)
        );

        // win下默认 指定powershell
        System.setProperty("COMSPEC", "powershell");

        // 启动 Solon Web 服务
        String accessKey = WebAccessFilter.createKey();
        Solon.start(LoopraWebApp.class, args, app -> {
            // Install before the listener starts accepting requests.
            WebAccessFilter.install(app, accessKey);
        });
        System.out.printf("""
                [Web Interface]: http://127.0.0.1:%s/index.html?rk=%s
                %n""", Solon.cfg().serverPort(), accessKey);

        // ==================== ACP 协议支持 ====================
        // 通过 --loopra.acp=true 启用
        boolean acpEnabled = Solon.cfg().getBool("loopra.acp", false);
        if (!acpEnabled) {
            return; // ACP 未启用，Web 服务正常启动后返回
        }

        // 检测 WebSocket 端口配置
        int acpWsPort = Solon.cfg().getInt("loopra.acp.ws.port", 0);

        try {
            if (acpWsPort > 0) {
                // WebSocket 模式（远程连接）
                System.out.println("[ACP] WebSocket 模式启动，端口: " + acpWsPort);
                AcpBootstrap.startWebSocket(acpWsPort);
            } else {
                // Stdio 模式（子进程通信）
                System.out.println("[ACP] Stdio 模式启动，等待客户端连接...");
                AcpBootstrap bootstrap = new AcpBootstrap(new StdioAcpAgentTransport());
                bootstrap.start(); // 非阻塞启动
                System.out.println("[ACP] ACP Agent 已在后台运行");
            }
        } catch (Exception e) {
            System.err.println("[ACP] 启动失败: " + e.getMessage());
            e.printStackTrace();
        }
    }
}
