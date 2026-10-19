package site.sorghum.loopra.web.controller;

import io.swagger.annotations.Api;
import io.swagger.annotations.ApiOperation;
import io.swagger.annotations.ApiParam;
import lombok.extern.slf4j.Slf4j;
import org.noear.solon.ai.talents.mount.SkillDir;
import org.noear.solon.annotation.Body;
import org.noear.solon.annotation.Controller;
import org.noear.solon.annotation.Get;
import org.noear.solon.annotation.Inject;
import org.noear.solon.annotation.Mapping;
import org.noear.solon.annotation.Param;
import org.noear.solon.annotation.Post;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.tool.solon.common.LoopraSkillProvider;
import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.common.WebErrorMessages;
import site.sorghum.loopra.web.model.AgentStatusDTO;
import site.sorghum.loopra.web.model.ApiResponse;
import site.sorghum.loopra.web.model.BashSessionDTO;
import site.sorghum.loopra.web.model.BashSessionLogDTO;
import site.sorghum.loopra.web.model.BashSessionTerminateRequest;
import site.sorghum.loopra.web.model.CommandMetaDTO;
import site.sorghum.loopra.web.model.PlanModeRequest;
import site.sorghum.loopra.web.model.ProjectCapabilitiesDTO;
import site.sorghum.loopra.web.model.PromptDTO;
import site.sorghum.loopra.web.model.SessionStatusDTO;
import site.sorghum.loopra.web.model.SkillMetaDTO;
import site.sorghum.loopra.web.service.AgentService;

import java.util.Collection;
import java.util.Collections;
import java.util.List;
import java.util.stream.Collectors;

/**
 * Agent 状态查询 API。
 *
 * @author Sorghum
 */
@Api(tags = "Agent 控制")
@Controller
@Mapping("/api/agent")
@Slf4j
public class AgentController {

    @Inject
    private AgentService agentService;

    @ApiOperation(value = "获取 Agent 状态", notes = "返回当前 Agent 的运行状态，包括模型、项目、会话等信息")
    @Get
    @Mapping("/status")
    public ApiResponse<AgentStatusDTO> status() {
        // 未就绪时也返回 ready=false，前端据此引导用户配置模型
        return ApiResponse.ok(agentService.getStatus());
    }

    @ApiOperation(value = "查询会话运行状态", notes = "按项目和会话精确返回当前后台 Agent 任务是否仍在执行")
    @Get
    @Mapping("/session-status")
    public ApiResponse<SessionStatusDTO> sessionStatus(
            @ApiParam(value = "项目 hash", required = true)
            @Param(value = "workspaceHash", required = true)
            String workspaceHash,
            @ApiParam(value = "会话名称", required = true)
            @Param(value = "sessionName", required = true)
            String sessionName) {
        if (!agentService.isReady()) {
            throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        }
        if (sessionName == null || sessionName.isBlank()) {
            throw new ServiceException("sessionName 不能为空");
        }
        String workspacePath = agentService.resolveProjectHashOrThrow(workspaceHash);
        return ApiResponse.ok(agentService.getSessionStatus(workspacePath, sessionName));
    }

    @ApiOperation(value = "查询 bash 后台命令会话", notes = "返回 bash_start 启动且仍在镜像窗口内的后台命令会话（含 60 秒内刚结束的）；workspaceHash 为空时返回全部项目")
    @Get
    @Mapping("/bash-sessions")
    public ApiResponse<List<BashSessionDTO>> bashSessions(
            @ApiParam(value = "项目 hash（可选，空则返回全部项目）", required = false)
            @Param(value = "workspaceHash", required = false)
            String workspaceHash) {
        if (!agentService.isReady()) {
            throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        }
        String workspacePath = workspaceHash == null || workspaceHash.isBlank()
                ? null : agentService.resolveProjectPath(workspaceHash);
        return ApiResponse.ok(agentService.listBashSessions(workspacePath));
    }

    @ApiOperation(value = "手动关闭 bash 后台会话", notes = "终止指定 session_id 的后台命令进程（前端手动关闭按钮），返回终止状态日志")
    @Post
    @Mapping("/bash-sessions/terminate")
    public ApiResponse<String> terminateBashSession(@Body BashSessionTerminateRequest request) {
        if (!agentService.isReady()) {
            throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        }
        if (request == null || request.getSessionId() == null || request.getSessionId().isBlank()) {
            throw new ServiceException("sessionId 不能为空");
        }
        String workspacePath = request.getWorkspaceHash() == null || request.getWorkspaceHash().isBlank()
                ? null : agentService.resolveProjectPath(request.getWorkspaceHash());
        String message = agentService.terminateBashSession(request.getSessionId(), workspacePath);
        if (message == null) {
            return ApiResponse.fail("会话不存在或已结束: " + request.getSessionId());
        }
        return ApiResponse.ok(message);
    }

    @ApiOperation(value = "查询 bash 后台会话输出日志", notes = "返回指定 session_id 后台命令会话自启动以来累积的输出日志（bash_start 初始输出 + bash_wait/stdin 增量输出）；workspaceHash 为空时在全部项目查找")
    @Get
    @Mapping("/bash-sessions/log")
    public ApiResponse<BashSessionLogDTO> bashSessionLog(
            @ApiParam(value = "会话 ID", required = true)
            @Param(value = "sessionId", required = true)
            String sessionId,
            @ApiParam(value = "项目 hash（可选，空则全部项目查找）", required = false)
            @Param(value = "workspaceHash", required = false)
            String workspaceHash) {
        if (!agentService.isReady()) {
            throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        }
        if (sessionId == null || sessionId.isBlank()) {
            throw new ServiceException("sessionId 不能为空");
        }
        String workspacePath = workspaceHash == null || workspaceHash.isBlank()
                ? null : agentService.resolveProjectPath(workspaceHash);
        BashSessionLogDTO dto = agentService.readBashSessionLog(sessionId, workspacePath);
        if (dto == null) {
            return ApiResponse.fail("会话不存在或已结束: " + sessionId);
        }
        return ApiResponse.ok(dto);
    }

    @ApiOperation(value = "获取历史消息", notes = "根据项目 hash 和会话名称获取历史消息列表")
    @Get
    @Mapping("/history")
    public ApiResponse<List<?>> history(
            @ApiParam(value = "项目 hash", required = true)
            @Param(value = "workspaceHash", required = true)
            String workspaceHash,
            @ApiParam(value = "会话名称", required = true)
            @Param(value = "sessionName", required = true)
            String sessionName) {
        if (!agentService.isReady()) {
            throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        }
        String workspacePath = agentService.resolveProjectPath(workspaceHash);
        return ApiResponse.ok(agentService.getHistory(workspacePath, sessionName));
    }

    @ApiOperation(value = "获取原始事件日志", notes = "返回会话压缩前保留的原始消息与 tool result，供审计与回放")
    @Get
    @Mapping("/history/events")
    public ApiResponse<List<ChatMessage>> historyEvents(
            @ApiParam(value = "项目 hash", required = true)
            @Param(value = "workspaceHash", required = true)
            String workspaceHash,
            @ApiParam(value = "会话名称", required = true)
            @Param(value = "sessionName", required = true)
            String sessionName) {
        if (!agentService.isReady()) {
            throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        }
        String workspacePath = agentService.resolveProjectPath(workspaceHash);
        return ApiResponse.ok(agentService.getRawEvents(workspacePath, sessionName));
    }

    @ApiOperation(value = "查询会话计划模式", notes = "返回指定会话是否处于计划模式（前端加载会话时恢复状态用）")
    @Get
    @Mapping("/mode")
    public ApiResponse<java.util.Map<String, Object>> mode(
            @ApiParam(value = "项目 hash", required = true)
            @Param(value = "workspaceHash", required = true)
            String workspaceHash,
            @ApiParam(value = "会话名称", required = true)
            @Param(value = "sessionName", required = true)
            String sessionName) {
        if (!agentService.isReady()) {
            throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        }
        String workspacePath = agentService.resolveProjectPath(workspaceHash);
        return ApiResponse.ok(agentService.getPlanState(workspacePath, sessionName));
    }

    @ApiOperation(value = "切换会话计划模式", notes = "由 Web UI 显式开启或关闭计划模式")
    @Post
    @Mapping("/mode")
    public ApiResponse<java.util.Map<String, Object>> updateMode(@Body PlanModeRequest request) {
        if (!agentService.isNativeReady()) {
            throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        }
        if (request == null || request.getSessionName() == null || request.getSessionName().isBlank()) {
            throw new ServiceException("请先选择会话");
        }
        String workspacePath = agentService.resolveProjectPath(request.getWorkspaceHash());
        return ApiResponse.ok(agentService.setPlanMode(
                workspacePath, request.getSessionName(), request.isEnabled()));
    }

    @ApiOperation(value = "获取可用命令列表", notes = "返回所有可用的聊天命令（如 /help、/retry、/compact 等）")
    @Get
    @Mapping("/commands")
    public ApiResponse<List<CommandMetaDTO>> commands() {
        if (!agentService.isReady()) {
            throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        }
        return ApiResponse.ok(agentService.getCommandMetaList());
    }

    @ApiOperation(value = "获取当前会话的系统提示词",
            notes = "返回切片聚合后的完整 system 内容（含项目文档、环境信息与工具协作约定）")
    @Get
    @Mapping("/prompt")
    public ApiResponse<PromptDTO> prompt(
            @ApiParam(value = "项目 hash") @Param(value = "workspaceHash", required = false) String workspaceHash,
            @ApiParam(value = "会话名称") @Param(value = "sessionName", required = false) String sessionName) {
        if (!agentService.isNativeReady()) {
            throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        }
        String workspacePath = workspaceHash != null ? agentService.resolveProjectPath(workspaceHash) : null;
        return ApiResponse.ok(agentService.getSystemPrompt(workspacePath, sessionName));
    }

    @ApiOperation(value = "获取当前项目能力", notes = "返回当前项目会话可见的项目 Skill 与项目级 MCP 摘要")
    @Get
    @Mapping("/project-capabilities")
    public ApiResponse<ProjectCapabilitiesDTO> projectCapabilities(
            @ApiParam(value = "项目 hash", required = true)
            @Param(value = "workspaceHash", required = true)
            String workspaceHash) {
        if (!agentService.isReady()) {
            throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        }
        String workspacePath = agentService.resolveProjectHashOrThrow(workspaceHash);
        return ApiResponse.ok(agentService.getProjectCapabilities(workspacePath));
    }

    @ApiOperation(value = "刷新当前项目能力", notes = "重新加载项目 .loopra 下的 Skill/MCP 配置；运行中的会话不会被强制中断")
    @Post
    @Mapping("/project-capabilities/refresh")
    public ApiResponse<ProjectCapabilitiesDTO> refreshProjectCapabilities(
            @ApiParam(value = "项目 hash", required = true)
            @Param(value = "workspaceHash", required = true)
            String workspaceHash) {
        if (!agentService.isReady()) {
            throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        }
        String workspacePath = agentService.resolveProjectHashOrThrow(workspaceHash);
        return ApiResponse.ok(agentService.refreshProjectCapabilities(workspacePath));
    }

    @ApiOperation(value = "获取可用 skill 列表", notes = "返回当前已注册的所有 skill")
    @Get
    @Mapping("/skills")
    public ApiResponse<List<SkillMetaDTO>> skills() {
        if (!agentService.isReady()) {
            throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        }
        try {
            LoopraSkillProvider skillProvider = LoopraSkillProvider.getOrCreate("~");
            skillProvider.getPoolManager().refresh();
            Collection<SkillDir> skills = skillProvider.getPoolManager().getSkills();

            List<SkillMetaDTO> result = skills.stream()
                    .map(s -> new SkillMetaDTO(
                            s.getName(),
                            s.getDescription(),
                            s.getAliasPath(),
                            "",
                            s.getRealPath().getFileName().toString()
                    ))
                    .collect(Collectors.toList());

            return ApiResponse.ok(result);
        } catch (Exception e) {
            log.warn("获取 skill 列表失败: {}", e.getMessage(), e);
            return ApiResponse.ok(Collections.emptyList());
        }
    }
}
