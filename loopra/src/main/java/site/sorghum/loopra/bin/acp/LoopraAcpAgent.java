package site.sorghum.loopra.bin.acp;

import com.agentclientprotocol.sdk.agent.SyncPromptContext;
import com.agentclientprotocol.sdk.annotation.AcpAgent;
import com.agentclientprotocol.sdk.annotation.Cancel;
import com.agentclientprotocol.sdk.annotation.CloseSession;
import com.agentclientprotocol.sdk.annotation.Initialize;
import com.agentclientprotocol.sdk.annotation.ListSessions;
import com.agentclientprotocol.sdk.annotation.LoadSession;
import com.agentclientprotocol.sdk.annotation.NewSession;
import com.agentclientprotocol.sdk.annotation.Prompt;
import com.agentclientprotocol.sdk.spec.AcpSchema;
import com.agentclientprotocol.sdk.spec.AcpSchema.AgentCapabilities;
import com.agentclientprotocol.sdk.spec.AcpSchema.CancelNotification;
import com.agentclientprotocol.sdk.spec.AcpSchema.CloseSessionRequest;
import com.agentclientprotocol.sdk.spec.AcpSchema.CloseSessionResponse;
import com.agentclientprotocol.sdk.spec.AcpSchema.ContentBlock;
import com.agentclientprotocol.sdk.spec.AcpSchema.EmbeddedResourceResource;
import com.agentclientprotocol.sdk.spec.AcpSchema.ImageContent;
import com.agentclientprotocol.sdk.spec.AcpSchema.Implementation;
import com.agentclientprotocol.sdk.spec.AcpSchema.InitializeRequest;
import com.agentclientprotocol.sdk.spec.AcpSchema.InitializeResponse;
import com.agentclientprotocol.sdk.spec.AcpSchema.ListSessionsResponse;
import com.agentclientprotocol.sdk.spec.AcpSchema.LoadSessionRequest;
import com.agentclientprotocol.sdk.spec.AcpSchema.LoadSessionResponse;
import com.agentclientprotocol.sdk.spec.AcpSchema.McpCapabilities;
import com.agentclientprotocol.sdk.spec.AcpSchema.NewSessionRequest;
import com.agentclientprotocol.sdk.spec.AcpSchema.NewSessionResponse;
import com.agentclientprotocol.sdk.spec.AcpSchema.PromptCapabilities;
import com.agentclientprotocol.sdk.spec.AcpSchema.PromptRequest;
import com.agentclientprotocol.sdk.spec.AcpSchema.PromptResponse;
import com.agentclientprotocol.sdk.spec.AcpSchema.Resource;
import com.agentclientprotocol.sdk.spec.AcpSchema.SessionCapabilities;
import com.agentclientprotocol.sdk.spec.AcpSchema.SessionInfo;
import com.agentclientprotocol.sdk.spec.AcpSchema.TextContent;
import com.agentclientprotocol.sdk.spec.AcpSchema.TextResourceContents;
import lombok.extern.slf4j.Slf4j;
import site.sorghum.loopra.bin.acp.AcpAgentOutput.AcpNotificationSender;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * ACP Agent 实现 —— 通过 ACP 协议暴露 Loopra 的完整能力。
 * <p>
 * 使用 ACP SDK 的注解式风格，通过 {@link AcpSessionManager} 将 ACP 协议方法
 * 映射到 Loopra 的核心引擎（AgentLoop）。
 * </p>
 *
 * <h3>协议映射</h3>
 * <pre>
 * ACP 方法        → Loopra 实现
 * initialize      → 返回协议版本 + 能力声明
 * session/new     → 创建 LoopraAgent 实例
 * session/prompt  → LoopraAgent.chat() + 流式输出
  * session/cancel  → LoopraAgent.abort()
  * session/close   → LoopraAgent.dispose()
 * session/list    → 列出活跃会话
 * </pre>
 *
 * @author Sorghum
 */
@AcpAgent(name = "loopra", version = "26.6.29")
@Slf4j
public class LoopraAcpAgent {

    /** ACP 会话管理器 */
    private final AcpSessionManager sessionManager;

    public LoopraAcpAgent(AcpSessionManager sessionManager) {
        this.sessionManager = sessionManager;
    }

    // ==================== ACP 初始化 ====================

    /**
     * 处理 initialize 请求 —— 协商协议版本和交换能力声明。
     */
    @Initialize
    public InitializeResponse initialize(InitializeRequest req) {
        log.info("[acp] 收到 initialize 请求: protocolVersion={}, clientInfo={}",
                req != null ? req.protocolVersion() : null,
                req != null ? req.clientInfo() : null);

        // 会话能力：支持 list 和 close（标记为空对象 {}，Jackson 需要 Map）
        Object emptyMarker = Collections.emptyMap();
        SessionCapabilities sessionCaps = new SessionCapabilities(emptyMarker, emptyMarker, null);

        AgentCapabilities capabilities = new AgentCapabilities(
                true,               // 是否支持加载会话
                sessionCaps,        // 会话能力
                new McpCapabilities(false, false),  // MCP 能力（http=false, sse=false）
                new PromptCapabilities(false, true, true), // 提示词能力（audio=false, embeddedContext=true, image=true）
                null,               // 提供商
                null                // 元数据扩展
        );

        return new InitializeResponse(
                AcpSchema.LATEST_PROTOCOL_VERSION,
                capabilities,
                List.of(),          // 认证方式：无需认证
                new Implementation("loopra", "Loopra", "26.6.29"),
                null                // 元数据扩展
        );
    }

    // ==================== 会话管理 ====================

    /**
     * 处理 session/new —— 创建新的 Loopra 会话。
     */
    @NewSession
    public NewSessionResponse newSession(NewSessionRequest req) {
        String cwd = req != null ? req.cwd() : System.getProperty("user.dir");
        log.info("[acp] 创建新会话: cwd={}", cwd);

        String sessionId = sessionManager.createSession(cwd, null);

        return new NewSessionResponse(sessionId, null, null);
    }

    /**
     * 处理 session/load —— 加载已有会话（支持从磁盘恢复）。
     * <p>
     * 加载优先级：内存缓存 → 磁盘持久化文件。
     * 如果磁盘上有 {@code {sessionId}.jsonl}，自动重建 LoopraAgent
     * 并恢复历史消息和 token 用量，实现重启后会话无缝恢复。
     * </p>
     */
    @LoadSession
    public LoadSessionResponse loadSession(LoadSessionRequest req) {
        if (req == null || req.sessionId() == null) {
            throw new IllegalArgumentException("sessionId is required");
        }
        String sessionId = req.sessionId();
        String cwd = req.cwd();
        log.info("[acp] 加载会话: sessionId={}, cwd={}", sessionId, cwd);

        // 尝试从内存或磁盘恢复
        boolean restored = sessionManager.loadOrRestoreSession(sessionId, cwd);
        if (!restored) {
            log.warn("[acp] 会话不存在: {}", sessionId);
            throw new IllegalArgumentException("Session not found: " + sessionId);
        }

        return new LoadSessionResponse(null, null);
    }

    /**
     * 处理 session/list —— 列出所有活跃会话。
     */
    @ListSessions
    public ListSessionsResponse listSessions() {
        List<AcpSessionManager.SessionInfo> acpSessions = sessionManager.listSessions();
        List<SessionInfo> sessions = acpSessions.stream()
                .map(s -> new SessionInfo(s.sessionId(), s.cwd()))
                .toList();
        return new ListSessionsResponse(sessions, null, null);
    }

    /**
     * 处理 session/close —— 关闭并释放会话资源。
     */
    @CloseSession
    public CloseSessionResponse closeSession(CloseSessionRequest req) {
        if (req != null && req.sessionId() != null) {
            log.info("[acp] 关闭会话: sessionId={}", req.sessionId());
            sessionManager.closeSession(req.sessionId());
        }
        return new CloseSessionResponse();
    }

    // ==================== 核心推理 ====================

    /**
     * 处理 session/prompt —— 将用户消息发送给 Loopra 处理。
     */
    @Prompt
    public PromptResponse handlePrompt(PromptRequest req, SyncPromptContext ctx) {
        if (req == null) {
            return PromptResponse.refusal();
        }

        String sessionId = req.sessionId();
        log.debug("[acp] 收到 prompt: sessionId={}", sessionId);

        try {
            // 1. 提取文本内容
            String text = extractText(req);

            // 2. 提取图片内容
            List<String> images = extractImages(req);

            // 3. 创建 ACP 输出适配器，包装 SyncPromptContext
            AcpNotificationSender sender = new SyncContextNotificationSender(ctx);
            AcpAgentOutput output = new AcpAgentOutput(sender);

            // 4. 执行 Agent 推理循环
            sessionManager.handlePrompt(sessionId, text, images, output);

            // 5. 标记完成
            output.markCompleted();

            return PromptResponse.endTurn();

        } catch (IllegalArgumentException e) {
            log.error("[acp] 会话不存在: {}", e.getMessage());
            return PromptResponse.refusal();
        } catch (Exception e) {
            log.error("[acp] prompt 处理异常: {}", e.getMessage(), e);
            ctx.sendMessage("处理请求时出错: " + e.getMessage());
            return PromptResponse.endTurn();
        }
    }

    // ==================== 中断与取消 ====================

    /**
     * 处理 session/cancel —— 中断正在进行的 prompt。
     */
    @Cancel
    public void handleCancel(CancelNotification req) {
        if (req != null && req.sessionId() != null) {
            log.info("[acp] 取消 prompt: sessionId={}", req.sessionId());
            sessionManager.cancelPrompt(req.sessionId());
        }
    }

    // ==================== 内容提取 ====================

    /**
     * 从 PromptRequest 中提取纯文本内容。
     */
    private String extractText(PromptRequest req) {
        List<ContentBlock> blocks = req.prompt();
        if (blocks == null || blocks.isEmpty()) {
            return "";
        }

        StringBuilder sb = new StringBuilder();
        for (ContentBlock block : blocks) {
            if (block instanceof TextContent text) {
                if (sb.length() > 0) sb.append("\n");
                sb.append(text.text());
            } else if (block instanceof Resource resource) {
                // 嵌入式资源可能包含文件内容
                EmbeddedResourceResource res = resource.resource();
                if (res instanceof TextResourceContents textRes) {
                    if (sb.length() > 0) sb.append("\n");
                    if (textRes.uri() != null) {
                        sb.append("[文件: ").append(textRes.uri()).append("]\n");
                    }
                    if (textRes.text() != null) {
                        sb.append(textRes.text());
                    }
                }
            }
        }
        return sb.toString();
    }

    /**
     * 从 PromptRequest 中提取图片内容（base64 data 或 URI）。
     */
    private List<String> extractImages(PromptRequest req) {
        List<ContentBlock> blocks = req.prompt();
        if (blocks == null || blocks.isEmpty()) {
            return List.of();
        }

        List<String> images = new ArrayList<>();
        for (ContentBlock block : blocks) {
            if (block instanceof ImageContent img) {
                if (img.data() != null && !img.data().isEmpty()) {
                    String mimeType = img.mimeType() != null ? img.mimeType() : "image/png";
                    images.add("data:" + mimeType + ";base64," + img.data());
                } else if (img.uri() != null && !img.uri().isEmpty()) {
                    images.add(img.uri());
                }
            }
        }
        return images;
    }

    // ==================== 内部类 ====================

    /**
     * 将 ACP SDK 的 SyncPromptContext 适配为 AcpAgentOutput.AcpNotificationSender。
     */
    private static class SyncContextNotificationSender implements AcpNotificationSender {

        private final SyncPromptContext ctx;

        SyncContextNotificationSender(SyncPromptContext ctx) {
            this.ctx = ctx;
        }

        @Override
        public void sendMessage(String text) {
            try {
                ctx.sendMessage(text);
            } catch (Exception e) {
                log.debug("[acp] 发送消息块失败（可能连接已断开）: {}", e.getMessage());
            }
        }

        @Override
        public void sendThought(String text) {
            try {
                ctx.sendThought(text);
            } catch (Exception e) {
                log.debug("[acp] 发送思考块失败: {}", e.getMessage());
            }
        }

        @Override
        public void sendContentComplete() {
            // SyncPromptContext 不需要显式的内容完成信号
        }

        @Override
        public void sendToolCall(String name, String args) {
            log.debug("[acp] 工具调用: name={}", name);
        }

        @Override
        public void sendToolResult(String name, String result) {
            log.debug("[acp] 工具结果: name={}", name);
        }

        @Override
        public void sendError(String error) {
            try {
                ctx.sendMessage("错误: " + error);
            } catch (Exception e) {
                log.warn("[acp] 发送错误失败: {}", e.getMessage());
            }
        }
    }
}
