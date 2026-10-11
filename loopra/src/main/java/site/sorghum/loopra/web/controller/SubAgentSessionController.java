package site.sorghum.loopra.web.controller;

import io.swagger.annotations.Api;
import io.swagger.annotations.ApiOperation;
import io.swagger.annotations.ApiParam;
import lombok.extern.slf4j.Slf4j;
import org.noear.snack4.ONode;
import org.noear.solon.annotation.Body;
import org.noear.solon.annotation.Controller;
import org.noear.solon.annotation.Delete;
import org.noear.solon.annotation.Get;
import org.noear.solon.annotation.Inject;
import org.noear.solon.annotation.Mapping;
import org.noear.solon.annotation.Param;
import org.noear.solon.annotation.Path;
import org.noear.solon.annotation.Post;
import org.noear.solon.core.handle.Context;
import site.sorghum.loopra.bin.agent.core.SubAgent;
import site.sorghum.loopra.bin.project.ProjectRegistry;
import site.sorghum.loopra.bin.session.SubAgentSessionManager;
import site.sorghum.loopra.bin.session.SubAgentSessionStore;
import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.common.WebErrorMessages;
import site.sorghum.loopra.web.model.ApiResponse;
import site.sorghum.loopra.web.model.SubSessionInfoDTO;
import site.sorghum.loopra.web.service.AgentService;
import site.sorghum.loopra.web.service.SseAgentOutput;
import site.sorghum.loopra.web.service.SseEmitter;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.FutureTask;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 子代理会话接口 —— 只读回放挂在主代理会话下的子代理执行过程，并对活跃会话提供「继续对话」。
 * <p>
 * 数据由 {@link SubAgentSessionStore} 落盘于 {sessionsDir}/{父会话}.sub/ 目录，
 * 按 workspaceHash（项目）与 sessionName（父会话）隔离；subSessionId 走白名单校验防目录穿越。
 * 继续对话仅对进程内活跃的会话（{@link SubAgentSessionManager} 登记、未被取消）可用：
 * 复用同一 SubAgent 的子循环与上下文，以 SSE 流式返回 sub_* 事件并续写落盘。
 * </p>
 *
 * @author Sorghum
 */
@Slf4j
@Api(tags = "子代理会话")
@Controller
@Mapping("/api/sub-sessions")
public class SubAgentSessionController {

    private static final AtomicInteger SUB_CHAT_THREAD_SEQ = new AtomicInteger(0);
    /** 继续对话 SSE 线程池（小而有界：子代理续跑并发度低） */
    private static final ExecutorService SUB_CHAT_EXECUTOR = Executors.newFixedThreadPool(4, r -> {
        Thread t = new Thread(r, "loopra-sub-chat-" + SUB_CHAT_THREAD_SEQ.incrementAndGet());
        t.setDaemon(true);
        return t;
    });

    @Inject
    private AgentService agentService;

    @Inject
    private SubAgentSessionManager subAgentSessionManager;

    @ApiOperation(value = "列出子代理会话", notes = "返回某主代理会话下全部子代理会话（按开始时间倒序）")
    @Get
    @Mapping("")
    public ApiResponse<List<SubSessionInfoDTO>> list(
            @ApiParam(value = "项目 hash", required = true)
            @Param(value = "workspaceHash", required = true) String workspaceHash,
            @ApiParam(value = "父代理会话名称（文件标识）", required = true)
            @Param(value = "sessionName", required = true) String sessionName) {
        if (!agentService.isReady()) throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        if (sessionName == null || sessionName.isBlank()) {
            throw new ServiceException("sessionName 参数不能为空");
        }
        SubAgentSessionStore store = storeFor(workspaceHash);
        List<SubSessionInfoDTO> dtos = store.list(sessionName).stream()
                .map(info -> new SubSessionInfoDTO(info.subSessionId(), info.task(), info.name(), info.title(),
                        info.profile(), info.status(), info.startedAt(), info.endedAt(), info.eventCount(), info.mtime()))
                .toList();
        return ApiResponse.ok(dtos);
    }

    @ApiOperation(value = "读取子代理会话事件", notes = "返回某子代理会话的全部事件（按发生顺序），前端据此重建回放块")
    @Get
    @Mapping("/{subSessionId}/events")
    public ApiResponse<List<Map<String, Object>>> events(
            @ApiParam(value = "子代理会话标识") @Path("subSessionId") String subSessionId,
            @ApiParam(value = "项目 hash", required = true)
            @Param(value = "workspaceHash", required = true) String workspaceHash,
            @ApiParam(value = "父代理会话名称（文件标识）", required = true)
            @Param(value = "sessionName", required = true) String sessionName) {
        if (!agentService.isReady()) throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        if (sessionName == null || sessionName.isBlank()) {
            throw new ServiceException("sessionName 参数不能为空");
        }
        if (!SubAgentSessionStore.isValidSubSessionId(subSessionId)) {
            throw new ServiceException("非法的子代理会话标识");
        }
        return ApiResponse.ok(storeFor(workspaceHash).events(sessionName, subSessionId));
    }

    @ApiOperation(value = "删除子代理会话", notes = "删除某主代理会话下的单个子代理会话（运行中的会话拒绝删除）")
    @Delete
    @Mapping("/{subSessionId}")
    public ApiResponse<Map<String, Object>> remove(
            @ApiParam(value = "子代理会话标识") @Path("subSessionId") String subSessionId,
            @ApiParam(value = "项目 hash", required = true)
            @Param(value = "workspaceHash", required = true) String workspaceHash,
            @ApiParam(value = "父代理会话名称（文件标识）", required = true)
            @Param(value = "sessionName", required = true) String sessionName) {
        if (!agentService.isReady()) throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        if (sessionName == null || sessionName.isBlank()) {
            throw new ServiceException("sessionName 参数不能为空");
        }
        if (!SubAgentSessionStore.isValidSubSessionId(subSessionId)) {
            throw new ServiceException("非法的子代理会话标识");
        }
        if (subAgentSessionManager.isRunning(subSessionId)) {
            throw new ServiceException("运行中的子代理会话无法删除");
        }
        SubAgentSessionStore store = storeFor(workspaceHash);
        if (!store.delete(sessionName, subSessionId)) {
            throw new ServiceException("子代理会话不存在或删除失败");
        }
        // 移除进程内登记，防止删除后仍可继续对话
        subAgentSessionManager.remove(subSessionId);
        return ApiResponse.ok(Map.of("subSessionId", subSessionId, "deleted", true));
    }

    /**
     * 继续对话 —— 对活跃的子代理会话追加一轮执行，SSE 流式返回 sub_* 事件并续写落盘。
     * <p>
     * 复用首次执行创建的 SubAgent（子循环与上下文保留在进程内），消息历史自然延续；
     * 仅当会话在进程内活跃且未被取消时可继续；执行结束后（或进程重启后）不可继续。
     * </p>
     *
     * @param rawBody {@code {"message": "..."}}
     */
    @ApiOperation(value = "继续对话", notes = "对活跃子代理会话追加一轮执行（SSE 流式返回 sub_* 事件）")
    @Post
    @Mapping("/{subSessionId}/chat")
    public void chat(@Body String rawBody, @Path("subSessionId") String subSessionId,
                     @ApiParam(value = "项目 hash", required = true)
                     @Param(value = "workspaceHash", required = true) String workspaceHash,
                     @ApiParam(value = "父代理会话名称（文件标识）", required = true)
                     @Param(value = "sessionName", required = true) String sessionName,
                     Context ctx) throws Exception {
        if (!agentService.isReady()) {
            ctx.outputAsJson(jsonError(WebErrorMessages.AGENT_NOT_READY));
            return;
        }
        if (!SubAgentSessionStore.isValidSubSessionId(subSessionId)) {
            ctx.outputAsJson(jsonError("非法的子代理会话标识"));
            return;
        }
        if (sessionName == null || sessionName.isBlank()) {
            ctx.outputAsJson(jsonError("sessionName 参数不能为空"));
            return;
        }
        String message = parseMessage(rawBody);
        if (message == null) {
            ctx.outputAsJson(jsonError("message 不能为空"));
            return;
        }
        String workspacePath = agentService.resolveProjectPath(workspaceHash);
        if (workspacePath == null) {
            ctx.outputAsJson(jsonError("项目不存在"));
            return;
        }
        SubAgentSessionStore store = new SubAgentSessionStore(new ProjectRegistry().getSessionsDir(workspacePath));
        if (store.events(sessionName, subSessionId).isEmpty()) {
            ctx.outputAsJson(jsonError("子代理会话不存在"));
            return;
        }
        if (!subAgentSessionManager.tryBeginRun(subSessionId)) {
            ctx.outputAsJson(jsonError("该子代理会话已结束或正在执行中，无法继续对话"));
            return;
        }
        SubAgent sub = subAgentSessionManager.find(subSessionId);
        if (sub == null) {
            subAgentSessionManager.endRun(subSessionId);
            ctx.outputAsJson(jsonError("该子代理会话已结束，无法继续对话（重启后仅保留回放）"));
            return;
        }

        SseEmitter emitter = new SseEmitter(ctx);
        // 本轮事件输出指向新的 SSE 通道，避免回流到已结束的父聊天流
        sub.setOutputTarget(new SseAgentOutput(emitter));
        FutureTask<Void> task = new FutureTask<>(() -> {
            try {
                sub.run(message, null);
            } catch (Exception e) {
                log.error("[sub-chat] 子代理继续对话失败: subSessionId={}, 原因: {}", subSessionId, e.getMessage(), e);
                try {
                    emitter.sendError(e.getMessage());
                } catch (Exception ex) {
                    log.warn("[sub-chat] 发送错误信息失败（SSE 连接可能已断开）: {}", ex.getMessage());
                }
            } finally {
                subAgentSessionManager.endRun(subSessionId);
                emitter.complete();
            }
        }, null);
        SUB_CHAT_EXECUTOR.execute(task);
        // 阻塞 handler 线程直到 SSE 流结束，防止 Solon 提前关闭 OutputStream
        emitter.awaitCompletion();
        // 会话结束（或连接断开）后恢复默认输出目标，避免残留引用
        sub.setOutputTarget(null);
    }

    private static String parseMessage(String rawBody) {
        if (rawBody == null || rawBody.isBlank()) return null;
        try {
            String message = ONode.ofJson(rawBody).get("message").getString();
            if (message == null || message.isBlank()) return null;
            return message.trim();
        } catch (Exception e) {
            return null;
        }
    }

    /** 构建 JSON 错误响应字符串（与 ChatController 一致）。 */
    private static String jsonError(String message) {
        return ONode.ofJson("{}").asObject().set("success", false).set("error", message).toJson();
    }

    private SubAgentSessionStore storeFor(String workspaceHash) {
        String workspacePath = agentService.resolveProjectPath(workspaceHash);
        if (workspacePath == null) {
            throw new ServiceException("项目不存在");
        }
        java.nio.file.Path sessionsDir = new ProjectRegistry().getSessionsDir(workspacePath);
        return new SubAgentSessionStore(sessionsDir);
    }
}
