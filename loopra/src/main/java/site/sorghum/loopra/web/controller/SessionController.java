package site.sorghum.loopra.web.controller;

import io.swagger.annotations.Api;
import io.swagger.annotations.ApiOperation;
import io.swagger.annotations.ApiParam;
import lombok.SneakyThrows;
import org.noear.solon.annotation.Body;
import org.noear.solon.annotation.Controller;
import org.noear.solon.annotation.Delete;
import org.noear.solon.annotation.Get;
import org.noear.solon.annotation.Inject;
import org.noear.solon.annotation.Mapping;
import org.noear.solon.annotation.Param;
import org.noear.solon.annotation.Path;
import org.noear.solon.annotation.Post;
import org.noear.solon.annotation.Put;
import site.sorghum.loopra.bin.checklist.Checklist;
import site.sorghum.loopra.bin.checklist.ChecklistStore;
import site.sorghum.loopra.bin.config.ConfigService;
import site.sorghum.loopra.bin.goal.Goal;
import site.sorghum.loopra.bin.goal.GoalStep;
import site.sorghum.loopra.bin.project.ProjectRegistry;
import site.sorghum.loopra.tool.interact.InteractionService;
import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.common.WebErrorMessages;
import site.sorghum.loopra.web.model.ApiResponse;
import site.sorghum.loopra.web.model.ChecklistStatusDTO;
import site.sorghum.loopra.web.model.FileChangeRevertDTO;
import site.sorghum.loopra.web.model.FileChangeRevertRequest;
import site.sorghum.loopra.web.model.GoalStatusDTO;
import site.sorghum.loopra.web.model.SessionCleanupDTO;
import site.sorghum.loopra.web.model.SessionCreateDTO;
import site.sorghum.loopra.web.model.SessionCurrentDTO;
import site.sorghum.loopra.web.model.SessionDeleteDTO;
import site.sorghum.loopra.web.model.SessionInfoDTO;
import site.sorghum.loopra.web.model.SessionRenameRequest;
import site.sorghum.loopra.web.model.SessionSettingsDTO;
import site.sorghum.loopra.web.model.SessionSettingsRequest;
import site.sorghum.loopra.web.model.SessionStatsDTO;
import site.sorghum.loopra.web.model.SessionSwitchDTO;
import site.sorghum.loopra.web.model.SessionWorktreeModeDTO;
import site.sorghum.loopra.web.model.SessionWorktreeModeRequest;
import site.sorghum.loopra.web.service.AgentService;
import site.sorghum.loopra.web.service.FileChangeRevertService;

import java.util.List;

/**
 * 会话管理 API 控制器。
 *
 * @author Sorghum
 */
@Api(tags = "会话管理")
@Controller
@Mapping("/api/sessions")
public class SessionController {

    @Inject
    private AgentService agentService;

    @Inject
    private InteractionService interactionService;

    private final FileChangeRevertService fileChangeRevertService = new FileChangeRevertService();

    /** 缓存统计默认上限 */
    private static final int DEFAULT_CACHE_LIMIT = 50;

    @ApiOperation(value = "撤销本轮文件变更", notes = "按该助手回复持久化的 diff 反向回打补丁，不撤回会话消息")
    @Post
    @Mapping("/file-changes/revert")
    public ApiResponse<FileChangeRevertDTO> revertFileChanges(
            @ApiParam(value = "文件变更撤销请求") @Body FileChangeRevertRequest request) {
        if (!agentService.isReady()) throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        if (request == null) throw new ServiceException("撤销请求不能为空");
        String workspacePath = agentService.resolveProjectHashOrThrow(request.workspaceHash);
        int count = fileChangeRevertService.revert(java.nio.file.Paths.get(workspacePath), request.changes);
        return ApiResponse.ok(new FileChangeRevertDTO("已撤销本次 AI 的文件修改", count));
    }
    @Get
    @Mapping("")
    public ApiResponse<List<SessionInfoDTO>> list(
            @ApiParam(value = "项目 hash")
            @Param(value = "workspaceHash", required = false) String workspaceHash) throws Exception {
        if (!agentService.isReady()) throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        String workspacePath = agentService.resolveProjectPath(workspaceHash);
        if (workspacePath == null) workspacePath = agentService.getCurrentProject();
        return ApiResponse.ok(agentService.listSessions(workspacePath));
    }

    @ApiOperation(value = "保存会话排序", notes = "按工作区保存会话名有序列表（侧边栏拖动排序）")
    @Put
    @Mapping("/order")
    public ApiResponse<String> saveOrder(
            @ApiParam(value = "项目 hash", required = true) @Param(value = "workspaceHash", required = true) String workspaceHash,
            @ApiParam(value = "会话名有序列表") @Body List<String> order) {
        if (!agentService.isReady()) throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        if (workspaceHash == null || workspaceHash.isBlank()) throw new ServiceException("项目 hash 不能为空");
        if (order == null) throw new ServiceException("排序数据不能为空");
        ConfigService.setSessionOrder(workspaceHash, order);
        return ApiResponse.ok("排序已保存");
    }

    @ApiOperation(value = "获取当前会话", notes = "返回当前活跃的会话信息（项目 hash + 会话名）")
    @Get
    @Mapping("/current")
    public ApiResponse<SessionCurrentDTO> current(
            @ApiParam(value = "项目 hash") @Param(value = "workspaceHash", required = false) String workspaceHash) {
        if (!agentService.isReady()) throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        String workspacePath = agentService.resolveProjectPath(workspaceHash);
        if (workspacePath == null) workspacePath = agentService.getCurrentProject();
        String currentName = agentService.getCurrentSessionName(workspacePath);
        String resolvedHash = workspaceHash != null ? workspaceHash : ProjectRegistry.computeProjectHash(workspacePath);
        return ApiResponse.ok(new SessionCurrentDTO(resolvedHash, currentName));
    }

    @ApiOperation(value = "新建空白会话", notes = "在指定项目下创建一个新的空白会话，可指定初始隔离分支模式")
    @Post
    @Mapping("/new")
    public ApiResponse<SessionCreateDTO> createNew(
            @ApiParam(value = "项目 hash", required = true) @Param(value = "workspaceHash", required = true) String workspaceHash,
            @ApiParam(value = "会话名称（可选，自动生成）")
            @Param(value = "sessionName", required = false) String sessionName,
            @ApiParam(value = "隔离分支模式（可选，默认 false）")
            @Param(value = "worktreeMode", required = false) Boolean worktreeMode) {
        if (!agentService.isReady()) throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        String workspacePath = agentService.resolveProjectHashOrThrow(workspaceHash);
        String actualName = agentService.newSession(workspacePath, sessionName, worktreeMode);
        return ApiResponse.ok(new SessionCreateDTO("已创建新会话", workspaceHash, actualName));
    }

    @ApiOperation(value = "获取会话模型设置", notes = "返回该会话固定使用的模型、渠道和思考强度；首次读取旧会话时会初始化设置")
    @Get
    @Mapping("/{name}/settings")
    public ApiResponse<SessionSettingsDTO> getSettings(
            @ApiParam(value = "会话名称") @Path("name") String name,
            @ApiParam(value = "项目 hash", required = true) @Param(value = "workspaceHash", required = true) String workspaceHash) {
        if (!agentService.isReady()) throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        String workspacePath = agentService.resolveProjectHashOrThrow(workspaceHash);
        return ApiResponse.ok(agentService.getSessionSettings(workspacePath, name));
    }

    @ApiOperation(value = "更新会话模型设置", notes = "只更新请求中提供的字段，不改变全局默认模型或其他会话")
    @Put
    @Mapping("/{name}/settings")
    public ApiResponse<SessionSettingsDTO> setSettings(
            @ApiParam(value = "会话名称") @Path("name") String name,
            @ApiParam(value = "项目 hash", required = true) @Param(value = "workspaceHash", required = true) String workspaceHash,
            @ApiParam(value = "请求体：{model, modelChannelId, reasoningEffort}") @Body SessionSettingsRequest request) {
        if (!agentService.isReady()) throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        if (request == null) throw new ServiceException("会话模型设置请求不能为空");
        String workspacePath = agentService.resolveProjectHashOrThrow(workspaceHash);
        return ApiResponse.ok(agentService.updateSessionSettings(
                workspacePath, name, request.getModel(), request.getModelChannelId(), request.getReasoningEffort()));
    }

    @ApiOperation(value = "查询会话隔离分支模式", notes = "返回指定会话的隔离分支模式开关与合并模式")
    @Get
    @Mapping("/{name}/worktree")
    public ApiResponse<SessionWorktreeModeDTO> getWorktreeMode(
            @ApiParam(value = "会话名称") @Path("name") String name,
            @ApiParam(value = "项目 hash", required = true) @Param(value = "workspaceHash", required = true) String workspaceHash) {
        if (!agentService.isReady()) throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        String workspacePath = agentService.resolveProjectHashOrThrow(workspaceHash);
        boolean worktreeMode = agentService.isSessionWorktreeMode(workspacePath, name);
        String mergeMode = agentService.getSessionMergeMode(workspacePath, name);
        return ApiResponse.ok(new SessionWorktreeModeDTO(workspaceHash, name, worktreeMode, mergeMode));
    }

    @ApiOperation(value = "重命名会话", notes = "修改会话显示名称（标题）；会话文件标识保持不变")
    @Put
    @Mapping("/{name}/title")
    public ApiResponse<String> renameSession(
            @ApiParam(value = "会话名称（文件标识）") @Path("name") String name,
            @ApiParam(value = "项目 hash", required = true) @Param(value = "workspaceHash", required = true) String workspaceHash,
            @ApiParam(value = "请求体：{title: 新的会话名称}") @Body SessionRenameRequest request) {
        if (!agentService.isReady()) throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        if (request == null || request.getTitle() == null || request.getTitle().isBlank()) {
            throw new ServiceException("新会话名称不能为空");
        }
        String workspacePath = agentService.resolveProjectHashOrThrow(workspaceHash);
        String newTitle = agentService.renameSession(workspacePath, name, request.getTitle());
        return ApiResponse.ok(newTitle);
    }

    @ApiOperation(value = "切换会话隔离分支模式", notes = "开启后该会话的 AI 文件操作落在隔离 git worktree 中；正在运行的会话不允许切换")
    @Put
    @Mapping("/{name}/worktree")
    public ApiResponse<SessionWorktreeModeDTO> setWorktreeMode(
            @ApiParam(value = "会话名称") @Path("name") String name,
            @ApiParam(value = "项目 hash", required = true) @Param(value = "workspaceHash", required = true) String workspaceHash,
            @ApiParam(value = "请求体：{worktreeMode: boolean, mergeMode: 'manual'|'ai-auto'|'ai-auto-approve'}（两个字段均可选）")
            @Body SessionWorktreeModeRequest request) {
        if (!agentService.isReady()) throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        if (request == null || (request.getWorktreeMode() == null && request.getMergeMode() == null)) {
            throw new ServiceException("请求不能为空，需提供 worktreeMode 或 mergeMode");
        }
        String workspacePath = agentService.resolveProjectHashOrThrow(workspaceHash);
        if (request.getWorktreeMode() != null) {
            agentService.setSessionWorktreeMode(workspacePath, name, request.getWorktreeMode());
        }
        if (request.getMergeMode() != null) {
            agentService.setSessionMergeMode(workspacePath, name, request.getMergeMode());
        }
        boolean worktreeMode = agentService.isSessionWorktreeMode(workspacePath, name);
        String mergeMode = agentService.getSessionMergeMode(workspacePath, name);
        return ApiResponse.ok(new SessionWorktreeModeDTO(workspaceHash, name, worktreeMode, mergeMode));
    }

    @ApiOperation(value = "切换会话", notes = "切换到指定项目下的指定会话")
    @SneakyThrows
    @Post
    @Mapping("/{name}")
    public ApiResponse<SessionSwitchDTO> switchSession(
            @ApiParam(value = "会话名称") @Path("name") String name,
            @ApiParam(value = "项目 hash", required = true) @Param(value = "workspaceHash", required = true) String workspaceHash) {
        if (!agentService.isReady()) throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        String workspacePath = agentService.resolveProjectHashOrThrow(workspaceHash);
        boolean ok = agentService.switchSession(workspacePath, name);
        if (ok) {
            String confirmedName = agentService.getCurrentSessionName(workspacePath);
            return ApiResponse.ok(
                    new SessionSwitchDTO(workspaceHash, confirmedName != null ? confirmedName : name, true));
        }
        throw new ServiceException("会话不存在: " + name);
    }

    @ApiOperation(value = "清空所有会话", notes = "清除指定项目下的所有会话磁盘文件和缓存")
    @Delete
    @Mapping("")
    public ApiResponse<SessionDeleteDTO> clearAllSessions(
            @ApiParam(value = "项目 hash", required = true)
            @Param(value = "workspaceHash", required = true) String workspaceHash) {
        if (!agentService.isReady()) throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        String workspacePath = agentService.resolveProjectHashOrThrow(workspaceHash);
        agentService.clearAllSessions(workspacePath);
        String resolvedHash = ProjectRegistry.computeProjectHash(workspacePath);
        return ApiResponse.ok(new SessionDeleteDTO("所有会话已清空", resolvedHash, null));
    }

    @ApiOperation(value = "清理过期会话", notes = "删除指定项目下最后活动时间早于 before（epoch 毫秒）的会话")
    @Delete
    @Mapping("/cleanup")
    public ApiResponse<SessionCleanupDTO> cleanupSessions(
            @ApiParam(value = "项目 hash", required = true)
            @Param(value = "workspaceHash", required = true) String workspaceHash,
            @ApiParam(value = "最后活动时间阈值（epoch 毫秒）", required = true)
            @Param(value = "before", required = true) Long before) {
        if (!agentService.isReady()) throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        if (before == null) throw new ServiceException("before 参数不能为空");
        String workspacePath = agentService.resolveProjectHashOrThrow(workspaceHash);
        List<String> deleted = agentService.clearSessionsBefore(workspacePath, before);
        String resolvedHash = ProjectRegistry.computeProjectHash(workspacePath);
        return ApiResponse.ok(new SessionCleanupDTO("已清理 " + deleted.size() + " 个过期会话", resolvedHash, deleted));
    }

    @ApiOperation(value = "删除会话", notes = "根据会话名称和项目删除指定会话")
    @Delete
    @Mapping("/{name}")
    public ApiResponse<SessionDeleteDTO> deleteSession(
            @ApiParam(value = "会话名称") @Path("name") String name,
            @ApiParam(value = "项目 hash") @Param(value = "workspaceHash") String workspaceHash) {
        if (!agentService.isReady()) throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        String workspacePath = agentService.resolveProjectPath(workspaceHash);
        agentService.deleteSession(workspacePath, name);
        String resolvedHash = workspaceHash != null ? workspaceHash : ProjectRegistry.computeProjectHash(workspacePath);
        return ApiResponse.ok(new SessionDeleteDTO("会话已删除", resolvedHash, name));
    }

    @ApiOperation(value = "清除 Agent 缓存", notes = "清除所有会话的 Agent 缓存，强制重新初始化")
    @Post
    @Mapping("/evict-all")
    public ApiResponse<String> evictAll() {
        if (!agentService.isReady()) throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        agentService.evictAllAgents();
        return ApiResponse.ok("已清除所有 Agent 缓存");
    }

    @ApiOperation(value = "分支会话", notes = "复制原始历史中从开头到指定排他结束位置的消息到新会话，并切换过去")
    @Post
    @Mapping("/{name}/branch")
    public ApiResponse<SessionCreateDTO> branchSession(
            @ApiParam(value = "源会话名称") @Path("name") String name,
            @ApiParam(value = "项目 hash", required = true) @Param(value = "workspaceHash", required = true) String workspaceHash,
            @ApiParam(value = "原始历史的排他结束位置", required = true) @Param(value = "messageCount", required = true) Integer messageCount) throws Exception {
        if (!agentService.isReady()) throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        if (messageCount == null || messageCount <= 0) throw new ServiceException("messageCount 必须大于 0");
        String workspacePath = agentService.resolveProjectHashOrThrow(workspaceHash);
        String newName = agentService.branchSession(workspacePath, name, messageCount);
        return ApiResponse.ok(new SessionCreateDTO("已分支到新会话", workspaceHash, newName));
    }

    @ApiOperation(value = "获取缓存统计", notes = "返回当前 Agent 缓存的数量和上限")
    @Get
    @Mapping("/stats")
    public ApiResponse<SessionStatsDTO> stats() {
        if (!agentService.isReady()) throw new ServiceException("Agent 未初始化");
        return ApiResponse.ok(new SessionStatsDTO(agentService.getCacheSize(), DEFAULT_CACHE_LIMIT));
    }

    @ApiOperation(value = "获取会话清单", notes = "返回指定会话的步骤列表清单状态")
    @Get
    @Mapping("/{name}/checklist")
    public ApiResponse<ChecklistStatusDTO> getChecklist(
            @ApiParam(value = "会话名称") @Path("name") String sessionName,
            @ApiParam(value = "项目 hash", required = true) @Param(value = "workspaceHash", required = true) String workspaceHash) {
        if (!agentService.isReady()) throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        String workspacePath = agentService.resolveProjectHashOrThrow(workspaceHash);
        
        ProjectRegistry projectRegistry = ProjectRegistry.getOrCreate(workspacePath);
        ChecklistStore store = projectRegistry.getChecklistStore();
        
        try {
            Checklist cl = store.findBySession(sessionName);
            if (cl == null) {
                return ApiResponse.ok(null);
            }
            return ApiResponse.ok(ChecklistStatusDTO.builder()
                    .checklistId(cl.getId())
                    .title(cl.getTitle())
                    .status(cl.getStatus())
                    .currentStepIndex(cl.getCurrentStepIndex())
                    .totalSteps(cl.getSteps().size())
                    .progress(cl.progressText())
                    .steps(cl.getSteps().stream().map(s -> ChecklistStatusDTO.StepDTO.builder()
                            .id(s.getId())
                            .description(s.getDescription())
                            .kind(s.getKind().name())
                            .status(s.getStatus().name())
                            .result(s.getResult())
                            .build()).collect(java.util.stream.Collectors.toList()))
                    .build());
        } catch (Exception e) {
            throw new ServiceException("获取清单失败: " + e.getMessage());
        }
    }

    @ApiOperation(value = "获取会话 Goal", notes = "返回指定会话的 Goal 状态和步骤")
    @Get
    @Mapping("/{name}/goal")
    public ApiResponse<GoalStatusDTO> getGoal(
            @ApiParam(value = "会话名称") @Path("name") String sessionName,
            @ApiParam(value = "项目 hash", required = true) @Param(value = "workspaceHash", required = true) String workspaceHash) {
        if (!agentService.isReady()) throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        String workspacePath = agentService.resolveProjectHashOrThrow(workspaceHash);

        ProjectRegistry projectRegistry = ProjectRegistry.getOrCreate(workspacePath);
        try {
            Goal goal = projectRegistry.getGoalStore().findBySession(sessionName);
            if (goal == null) {
                return ApiResponse.ok(null);
            }
            long doneSteps = goal.getSteps() == null ? 0 :
                    goal.getSteps().stream().filter(GoalStep::isClosed).count();
            return ApiResponse.ok(GoalStatusDTO.builder()
                    .goalId(goal.getId())
                    .title(goal.getTitle())
                    .description(goal.getDescription())
                    .status(goal.getStatus().name())
                    .progress(goal.progressText())
                    .totalSteps(goal.getSteps() == null ? 0 : goal.getSteps().size())
                    .doneSteps((int) doneSteps)
                    .verifyCommand(goal.getVerifyCommand())
                    .blockedReason(goal.getBlockedReason())
                    .completionSummary(goal.getCompletionSummary())
                    .steps(goal.getSteps() == null ? List.of() : goal.getSteps().stream()
                            .map(s -> GoalStatusDTO.StepDTO.builder()
                                    .index(s.getIndex())
                                    .description(s.getDescription())
                                    .status(s.getStatus().name())
                                    .evidence(s.getEvidence())
                                    .build())
                            .collect(java.util.stream.Collectors.toList()))
                    .build());
        } catch (Exception e) {
            throw new ServiceException("获取 Goal 失败: " + e.getMessage());
        }
    }

}
