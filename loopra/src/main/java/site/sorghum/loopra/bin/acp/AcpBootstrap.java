package site.sorghum.loopra.bin.acp;

import com.agentclientprotocol.sdk.agent.support.AcpAgentSupport;
import com.agentclientprotocol.sdk.agent.transport.StdioAcpAgentTransport;
import com.agentclientprotocol.sdk.spec.AcpAgentTransport;
import lombok.extern.slf4j.Slf4j;

import java.io.Closeable;
import java.io.IOException;

/**
 * ACP 协议引导程序 —— 启动 ACP Agent 传输层并绑定 Loopra 引擎。
 * <p>
 * 支持两种传输模式：
 * <ul>
 *   <li><b>stdio</b> — 子进程模式，通过标准输入/输出与编辑器进程通信</li>
 *   <li><b>WebSocket</b> — 远程模式，通过 WebSocket 连接接受客户端连接（需 acp-websocket-jetty）</li>
 * </ul>
 * </p>
 *
 * <h3>使用方式</h3>
 * <pre>
 * // CLI 启动（stdio 传输）
 * AcpBootstrap.startStdio();
 *
 * // Web 应用启动（WebSocket 传输）
 * AcpBootstrap.startWebSocket(port);
 *
 * // 关闭
 * bootstrap.close();
 * </pre>
 *
 * @author Sorghum
 */
@Slf4j
public class AcpBootstrap implements Closeable {

    private final AcpAgentSupport agentSupport;
    private final AcpSessionManager sessionManager;
    private final Thread shutdownHook;

    /**
     * 创建 ACP Agent 实例并绑定到指定传输层。
     *
     * @param transport ACP 传输层实现（stdio / WebSocket）
     */
    public AcpBootstrap(AcpAgentTransport transport) {
        this.sessionManager = new AcpSessionManager();
        LoopraAcpAgent agent = new LoopraAcpAgent(sessionManager);

        this.agentSupport = AcpAgentSupport.create(agent)
                .transport(transport)
                .build();
        agent.setUpdateSender(agentSupport.getAgent()::sendSessionUpdate);

        // 注册 JVM 关闭钩子
        this.shutdownHook = new Thread(() -> {
            log.info("[acp] JVM 关闭，清理 ACP 资源...");
            try {
                close();
            } catch (Exception e) {
                log.warn("[acp] 关闭异常: {}", e.getMessage());
            }
        });
        Runtime.getRuntime().addShutdownHook(shutdownHook);

        log.info("[acp] ACP Agent 初始化完成，传输层: {}", transport.getClass().getSimpleName());
    }

    /**
     * 以 stdio 传输模式启动 ACP Agent（阻塞运行，直到客户端断开）。
     * <p>
     * 此模式适用于编辑器将 Loopra 作为子进程启动的场景。
     * Agent 通过 stdin/stdout 与编辑器进程通信。
     * </p>
     */
    public static AcpBootstrap startStdio() {
        log.info("[acp] 启动 ACP Agent（stdio 模式）...");
        StdioAcpAgentTransport transport = new StdioAcpAgentTransport();
        AcpBootstrap bootstrap = new AcpBootstrap(transport);
        bootstrap.startAndAwait();
        return bootstrap;
    }

    /**
     * 以 WebSocket 传输模式启动 ACP Agent（非阻塞，异步接受连接）。
     * <p>
     * 此模式适用于远程连接场景，编辑器或其他 ACP 客户端
     * 可以通过 WebSocket 连接到 Loopra。
     * </p>
     *
     * @param port WebSocket 端口号
     * @return AcpBootstrap 实例
     */
    public static AcpBootstrap startWebSocket(int port) {
        log.info("[acp] 启动 ACP Agent（WebSocket 模式，端口 {})...", port);
        try {
            // 使用反射加载 WebSocket 传输类，避免硬依赖
            Class<?> transportClass = Class.forName(
                    "com.agentclientprotocol.sdk.agent.transport.WebSocketAcpAgentTransport");
            var transport = transportClass.getMethod("create", int.class)
                    .invoke(null, port);
            AcpBootstrap bootstrap = new AcpBootstrap((AcpAgentTransport) transport);
            bootstrap.start();
            return bootstrap;
        } catch (ClassNotFoundException e) {
            log.warn("[acp] acp-websocket-jetty 未在 classpath 中，WebSocket 模式不可用");
            log.warn("[acp] 请添加依赖: com.agentclientprotocol:acp-websocket-jetty:0.14.0");
            throw new RuntimeException("WebSocket 传输不可用，缺少 acp-websocket-jetty 依赖", e);
        } catch (Exception e) {
            throw new RuntimeException("启动 WebSocket ACP Agent 失败", e);
        }
    }

    /**
     * 启动 ACP Agent（非阻塞）。
     */
    public void start() {
        agentSupport.start();
        log.info("[acp] ACP Agent 已启动，等待客户端连接...");
    }

    /**
     * 启动 ACP Agent 并阻塞等待（适用于 stdio 模式）。
     */
    public void startAndAwait() {
        agentSupport.run();
        log.info("[acp] ACP Agent 运行结束");
    }

    /**
     * 获取会话管理器。
     */
    public AcpSessionManager getSessionManager() {
        return sessionManager;
    }

    @Override
    public void close() throws IOException {
        try {
            // 关闭 ACP Agent
            agentSupport.close();
        } catch (Exception e) {
            log.warn("[acp] 关闭 ACP Agent 时异常: {}", e.getMessage());
        }

        // 释放所有会话资源
        sessionManager.dispose();

        // 移除关闭钩子
        try {
            Runtime.getRuntime().removeShutdownHook(shutdownHook);
        } catch (Exception e) {
            // 可能已经在关闭过程中
        }

        log.info("[acp] ACP Agent 已关闭");
    }
}
