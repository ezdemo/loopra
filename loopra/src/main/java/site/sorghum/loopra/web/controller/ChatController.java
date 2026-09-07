package site.sorghum.loopra.web.controller;

import io.swagger.annotations.Api;
import io.swagger.annotations.ApiImplicitParam;
import io.swagger.annotations.ApiImplicitParams;
import io.swagger.annotations.ApiOperation;
import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.ONode;
import org.noear.solon.annotation.*;
import org.noear.solon.core.handle.Context;
import site.sorghum.loopra.bin.agent.hitl.SubAgentHITLBroker;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.web.common.WebErrorMessages;
import site.sorghum.loopra.web.model.ApiResponse;
import site.sorghum.loopra.web.model.ChatRequest;
import site.sorghum.loopra.web.service.AgentService;
import site.sorghum.loopra.web.service.PasteContentService;
import site.sorghum.loopra.web.service.SnapshotService;
import site.sorghum.loopra.web.service.SseEmitter;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 聊天 API 控制器 —— 同步聊天 + SSE 流式聊天。
 *
 * @author Sorghum
 */
@Slf4j
@Api(tags = "聊天")
@Controller
@Mapping("/api/chat")
public class ChatController {

    /** 流式聊天并发上限 */
    private static final int CHAT_STREAM_MAX_THREADS = 16;

    /**
     * SSE 流式聊天线程池 — 有界固定大小，避免无限制线程创建导致资源耗尽。
     */
    private final ExecutorService chatExecutor = Executors.newFixedThreadPool(
            CHAT_STREAM_MAX_THREADS, new ChatStreamThreadFactory());
    /** 请求级流任务，使停止请求在 Agent 创建前也能取消后台工作。 */
    private final ConcurrentHashMap<String, Future<?>> activeChatTasks = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, SseEmitter> activeChatEmitters = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, AtomicBoolean> activeChatStarted = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, ChatSessionKey> activeChatTaskSessions = new ConcurrentHashMap<>();
    /** 处理停止请求先于流任务登记到达的竞态；过期项在后续请求时清理。 */
    private final ConcurrentHashMap<String, Long> cancelledChatRequests = new ConcurrentHashMap<>();
    private static final long CANCEL_MARKER_TTL_MS = 5 * 60 * 1000L;

    @Inject
    private AgentService agentService;

    @Inject
    private SnapshotService snapshotService;

    @Inject
    private PasteContentService pasteContentService;

    @ApiOperation(value = "中断当前聊天", notes = "发送中断信号给正在进行的聊天会话")
    @Post
    @Mapping("/abort")
    public ApiResponse<String> abort(@Body ChatRequest request) {
        if (request != null && request.getRequestId() != null && !request.getRequestId().isBlank()) {
            cancelStreamTask(request.getRequestId());
        }
        if (request != null && (request.getWorkspaceHash() != null || request.getSessionName() != null)) {
            agentService.abortChat(agentService.resolveProjectPath(request.getWorkspaceHash()), request.getSessionName());
        } else {
            agentService.abortCurrentChat();
        }
        log.info("[chat] 收到停止请求: session={}, requestId={}",
                request == null ? null : request.getSessionName(),
                request == null ? null : request.getRequestId());
        return ApiResponse.ok("已发送中断请求");
    }

    /**
     * 子代理 HITL 审批端点 —— 前端用户点击审批按钮后调用。
     * <p>释放对应 subId 的 CountDownLatch，使阻塞在 SubAgent.run() 中的子代理恢复执行。</p>
     */
    @Post
    @Mapping("/sub-hitl/{subId}")
    public ApiResponse<Map<String, Object>> approveSubHitl(@Path int subId, @Body String body) {
        String action = "";
        try {
            var node = org.noear.snack4.ONode.ofJson(body);
            action = node.get("action").getString();
        } catch (Exception e) {
            return ApiResponse.fail("无法解析请求体: " + e.getMessage());
        }
        if (!"approve".equals(action) && !"deny".equals(action)) {
            return ApiResponse.fail("action 必须为 'approve' 或 'deny'");
        }
        SubAgentHITLBroker.resolve(subId, "approve".equals(action));
        log.info("[sub-hitl] 子代理审批: subId={}, action={}", subId, action);
        return ApiResponse.ok(Map.of("subId", subId, "action", action));
    }

    @ApiOperation(value = "SSE 流式聊天", notes = "通过 Server-Sent Events 流式返回聊天回复，支持实时推送内容片段")
    @ApiImplicitParams({
            @ApiImplicitParam(name = "message", value = "用户消息；仅上传图片时可为空"),
            @ApiImplicitParam(name = "workspaceHash", value = "项目 hash"),
            @ApiImplicitParam(name = "sessionName", value = "会话名称")
    })
    @Post
    @Mapping("/stream")
    public void chatStream(@Body ChatRequest request, Context ctx) throws Exception {
        if (!agentService.isReady()) {
            ctx.outputAsJson(jsonError(WebErrorMessages.AGENT_NOT_READY));
            return;
        }
        boolean executePlan = request != null && "execute_plan".equals(request.getAction());
        boolean hasText = request != null && request.getMessage() != null
                && !request.getMessage().trim().isEmpty();
        boolean hasImages = request != null && request.getImages() != null
                && request.getImages().stream().anyMatch(image -> image != null && !image.isBlank());
        if (request == null || (!executePlan && !hasText && !hasImages)) {
            ctx.outputAsJson(jsonError(WebErrorMessages.MESSAGE_REQUIRED));
            return;
        }

        SseEmitter emitter = new SseEmitter(ctx);
        final String rawMessage = request.getMessage() != null ? request.getMessage().trim() : "";
        final String resolvedPath = agentService.resolveProjectPath(request.getWorkspaceHash());
        final String message = pasteContentService.externalizeIfNeeded(resolvedPath, rawMessage);
        final UserMessage userMsg = UserMessage.of(message, request.getImages());
        final String linkedProjectContext = agentService.buildLinkedProjectContext(
                request.getLinkedProjectHashes(), request.getWorkspaceHash());
        final String sessionName = request.getSessionName();
        final String requestId = ensureRequestId(request);

        AtomicBoolean taskStarted = new AtomicBoolean(false);
        Runnable streamTask = () -> {
            taskStarted.set(true);
            try {
                // ★ 创建快照检查点：在 AI 执行修改前保存当前项目状态
                String msgId = UUID.randomUUID().toString().substring(0, 8);
                boolean snapshotCreated = createCheckpointIfNeeded(request.getWorkspaceHash(), msgId, emitter);
                if (Thread.currentThread().isInterrupted()) return;
                // 每条用户消息都有会话撤回点；代码快照是否可用由事件字段标识。
                userMsg.setRollbackId(msgId);
                emitter.sendSnapshot(msgId, snapshotCreated);
                if (snapshotCreated) {
                    // 将快照 ID 传递给 UserMessage，以便 JSONL 持久化
                    userMsg.setSnapshotId(msgId);
                }

                // ★ 隔离分支开关透传：请求携带时先持久化到会话元数据，Agent 创建时读取
                if (request.getWorktreeMode() != null || request.getMergeMode() != null) {
                    try {
                        if (request.getWorktreeMode() != null) {
                            agentService.setSessionWorktreeMode(resolvedPath, sessionName, request.getWorktreeMode());
                        }
                        if (request.getMergeMode() != null && !request.getMergeMode().isBlank()) {
                            agentService.setSessionMergeMode(resolvedPath, sessionName, request.getMergeMode());
                        }
                    } catch (Exception e) {
                        // 开关持久化失败不应阻塞聊天：会话已存在且正在运行时只记录
                        log.warn("[chat] 持久化隔离分支开关失败: {}", e.getMessage());
                    }
                }

                agentService.chatStream(userMsg, resolvedPath, sessionName, emitter,
                        request.getModel(), request.getModelChannelId(), request.getReasoningEffort(),
                        request.getFastMode(), request.getAction(), linkedProjectContext);
            } catch (Exception e) {
                log.error("[chat] 流任务执行异常: session={}, requestId={}, 原因: {}",
                        sessionName, requestId, e.getMessage(), e);
                try {
                    emitter.sendError(e.getMessage());
                } catch (Exception ex) {
                    log.warn("[web] 发送错误信息失败（可能SSE连接已断开）: {}", ex.getMessage());
                }
            } finally {
                cleanupStreamTask(requestId, emitter);
                emitter.complete();
            }
        };
        FutureTask<Void> task = new FutureTask<>(streamTask, null);
        registerStreamTask(requestId, resolvedPath, sessionName, task, emitter, taskStarted);
        if (!task.isCancelled()) {
            chatExecutor.execute(task);
        }

        // ★ 关键：阻塞 handler 线程直到 SSE 流结束，防止 Solon 提前关闭 OutputStream
        emitter.awaitCompletion();
    }

    private String ensureRequestId(ChatRequest request) {
        String requestId = request.getRequestId();
        if (requestId == null || requestId.isBlank()) {
            requestId = UUID.randomUUID().toString();
            request.setRequestId(requestId);
        }
        return requestId;
    }

    private void registerStreamTask(String requestId, String workspacePath, String sessionName,
                                    FutureTask<Void> task, SseEmitter emitter,
                                    AtomicBoolean taskStarted) {
        if (requestId == null || requestId.isBlank()) return;
        cleanupExpiredCancelMarkers();
        activeChatTaskSessions.put(requestId, new ChatSessionKey(workspacePath, sessionName));
        agentService.registerSessionTask(workspacePath, sessionName, requestId);
        activeChatTasks.put(requestId, task);
        activeChatEmitters.put(requestId, emitter);
        activeChatStarted.put(requestId, taskStarted);
        if (cancelledChatRequests.remove(requestId) != null) {
            activeChatTasks.remove(requestId, task);
            activeChatEmitters.remove(requestId, emitter);
            activeChatStarted.remove(requestId, taskStarted);
            unregisterSessionTask(requestId);
            task.cancel(true);
            emitter.complete();
        }
    }

    private void cancelStreamTask(String requestId) {
        cleanupExpiredCancelMarkers();
        cancelledChatRequests.put(requestId, System.currentTimeMillis());
        Future<?> task = activeChatTasks.remove(requestId);
        AtomicBoolean taskStarted = activeChatStarted.remove(requestId);
        unregisterSessionTask(requestId);
        if (task != null) {
            task.cancel(true);
            log.info("[chat] 已取消流任务: requestId={}", requestId);
        } else {
            log.warn("[chat] 流任务未命中（可能请求已结束或 requestId 不匹配）: requestId={}", requestId);
        }
        SseEmitter emitter = activeChatEmitters.remove(requestId);
        // 已启动任务必须自行完成 finally，让计划恢复事件在 SSE 关闭前送达。
        if (emitter != null && (taskStarted == null || !taskStarted.get())) emitter.complete();
    }

    private void cleanupStreamTask(String requestId, SseEmitter emitter) {
        if (requestId == null || requestId.isBlank()) return;
        activeChatTasks.remove(requestId);
        activeChatEmitters.remove(requestId, emitter);
        activeChatStarted.remove(requestId);
        unregisterSessionTask(requestId);
        cancelledChatRequests.remove(requestId);
    }

    private void unregisterSessionTask(String requestId) {
        ChatSessionKey session = activeChatTaskSessions.remove(requestId);
        if (session != null) {
            agentService.unregisterSessionTask(session.workspacePath(), session.sessionName(), requestId);
        }
    }

    private record ChatSessionKey(String workspacePath, String sessionName) {
    }

    private void cleanupExpiredCancelMarkers() {
        long cutoff = System.currentTimeMillis() - CANCEL_MARKER_TTL_MS;
        cancelledChatRequests.entrySet().removeIf(entry -> entry.getValue() < cutoff);
    }

    /**
     * 按需创建快照检查点：仅当项目是 Git 仓库时才创建，非 Git 仓库静默跳过。
     *
     * @return true 表示快照创建成功，false 表示跳过或失败
     */
    private boolean createCheckpointIfNeeded(String workspaceHash, String msgId, SseEmitter emitter) {
        try {
            if (snapshotService.isGitRepo(workspaceHash)) {
                SnapshotService.SnapshotInfo info = snapshotService.createCheckpoint(workspaceHash, msgId);
                log.info("[chat] 快照已创建: msgId={}, commitHash={}", msgId, info.getCommitHash());
                return true;
            } else {
                log.debug("[chat] 项目非 Git 仓库，跳过快照创建");
            }
        } catch (Exception e) {
            // 快照失败不应阻塞聊天流程，仅记录日志
            log.warn("[chat] 创建快照检查点失败（不影响聊天）: {}", e.getMessage());
        }
        return false;
    }

    /** 构建 JSON 错误响应字符串。 */
    private static String jsonError(String message) {
        return ONode.ofJson("{}").asObject().set("success", false).set("error", message).toJson();
    }

    /** 流式聊天线程命名工厂。 */
    private static final class ChatStreamThreadFactory implements ThreadFactory {
        private final AtomicInteger counter = new AtomicInteger(0);

        @Override
        public Thread newThread(Runnable r) {
            final Thread t = new Thread(r, "loopra-chat-stream-" + counter.incrementAndGet());
            t.setDaemon(true);
            return t;
        }
    }
}
