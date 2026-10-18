package site.sorghum.loopra.web.controller;

import io.swagger.annotations.Api;
import io.swagger.annotations.ApiImplicitParam;
import io.swagger.annotations.ApiImplicitParams;
import io.swagger.annotations.ApiOperation;
import lombok.extern.slf4j.Slf4j;
import org.noear.solon.annotation.Body;
import org.noear.solon.annotation.Controller;
import org.noear.solon.annotation.Get;
import org.noear.solon.annotation.Param;
import org.noear.solon.annotation.Inject;
import org.noear.solon.annotation.Mapping;
import org.noear.solon.annotation.Path;
import org.noear.solon.annotation.Post;
import org.noear.solon.core.handle.Context;
import site.sorghum.loopra.bin.agent.hitl.SubAgentHITLBroker;
import site.sorghum.loopra.bin.agent.model.UserMessage;
import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.common.WebErrorMessages;
import site.sorghum.loopra.web.model.ApiResponse;
import site.sorghum.loopra.web.model.ChatRequest;
import site.sorghum.loopra.web.model.SubAgentHitlRequest;
import site.sorghum.loopra.web.service.AgentService;
import site.sorghum.loopra.web.service.ChatRequestValidator;
import site.sorghum.loopra.web.service.ChatTaskService;
import site.sorghum.loopra.web.service.PasteContentService;
import site.sorghum.loopra.web.service.SnapshotService;
import site.sorghum.loopra.web.service.SseEmitter;

import java.util.Map;
import java.util.UUID;

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
    public record PermissionAnswer(String workspaceHash, String sessionName, String permissionRequestId, String optionId) {}

    @Post
    @Mapping("/permission")
    public ApiResponse<String> permission(@Body PermissionAnswer answer) {
        if (answer == null || answer.workspaceHash() == null || answer.sessionName() == null
                || answer.permissionRequestId() == null || answer.optionId() == null) {
            throw new ServiceException("审批需要项目、会话、请求 ID 和选项 ID");
        }
        agentService.resolveAcpPermission(agentService.resolveProjectHashOrThrow(answer.workspaceHash()),
                answer.sessionName(), answer.permissionRequestId(), answer.optionId());
        return ApiResponse.ok("审批已提交");
    }

    @Get
    @Mapping("/permissions")
    public ApiResponse<java.util.List<Map<String, Object>>> permissions(
            @Param(value = "workspaceHash", required = true) String workspaceHash,
            @Param(value = "sessionName", required = true) String sessionName) {
        return ApiResponse.ok(agentService.pendingAcpPermissions(
                agentService.resolveProjectHashOrThrow(workspaceHash), sessionName));
    }

    @Inject
    private AgentService agentService;

    @Inject
    private ChatTaskService chatTaskService;

    @Inject
    private SnapshotService snapshotService;

    @Inject
    private PasteContentService pasteContentService;

    @ApiOperation(value = "中断当前聊天", notes = "发送中断信号给正在进行的聊天会话")
    @Post
    @Mapping("/abort")
    public ApiResponse<String> abort(@Body ChatRequest request) {
        if (request != null && request.getRequestId() != null && !request.getRequestId().isBlank()) {
            chatTaskService.cancel(request.getRequestId());
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
    public ApiResponse<Map<String, Object>> approveSubHitl(@Path("subId") int subId, @Body SubAgentHitlRequest request) {
        String action = request == null ? null : request.action();
        if (!"approve".equals(action) && !"deny".equals(action)) {
            throw new ServiceException("action 必须为 'approve' 或 'deny'");
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
        ChatRequestValidator.validate(request);
        if (!agentService.isReady()) {
            throw new ServiceException(503, WebErrorMessages.AGENT_NOT_READY);
        }
        final String rawMessage = request.getMessage() != null ? request.getMessage().trim() : "";
        final String resolvedPath = agentService.resolveProjectPath(request.getWorkspaceHash());
        final String message = pasteContentService.externalizeIfNeeded(resolvedPath, rawMessage);
        final UserMessage userMsg = UserMessage.of(message, request.getImages());
        final String linkedProjectContext = agentService.buildLinkedProjectContext(
                request.getLinkedProjectHashes(), request.getWorkspaceHash());
        final String sessionName = request.getSessionName();
        final String requestId = ensureRequestId(request);

        SseEmitter emitter = new SseEmitter(ctx);
        Runnable streamTask = () -> {
            try {
                // ★ 创建快照检查点：在 AI 执行修改前保存当前项目状态
                String msgId = UUID.randomUUID().toString().substring(0, 8);
                boolean snapshotCreated = createCheckpointIfNeeded(request.getWorkspaceHash(), msgId);
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
                    emitter.sendError(WebErrorMessages.publicMessage(e));
                } catch (Exception ex) {
                    log.warn("[web] 发送错误信息失败（可能SSE连接已断开）: {}", ex.getMessage());
                }
            }
        };
        try {
            chatTaskService.submit(requestId, resolvedPath, sessionName, streamTask, failure -> {
                if (failure != null) emitter.sendError(failure.getMessage());
                emitter.complete();
            });
        } catch (Exception exception) {
            // Admission errors happen after SSE initialization; report them through the same stream.
            log.warn("[chat] 登记流任务失败: requestId={}", requestId, exception);
            emitter.sendError(WebErrorMessages.publicMessage(exception));
            emitter.complete();
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

    /**
     * 按需创建快照检查点：仅当项目是 Git 仓库时才创建，非 Git 仓库静默跳过。
     *
     * @return true 表示快照创建成功，false 表示跳过或失败
     */
    private boolean createCheckpointIfNeeded(String workspaceHash, String msgId) {
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

}
