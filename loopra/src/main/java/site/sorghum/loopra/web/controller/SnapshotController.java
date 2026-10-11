package site.sorghum.loopra.web.controller;

import io.swagger.annotations.Api;
import io.swagger.annotations.ApiOperation;
import io.swagger.annotations.ApiParam;
import org.noear.solon.annotation.Controller;
import org.noear.solon.annotation.Delete;
import org.noear.solon.annotation.Get;
import org.noear.solon.annotation.Inject;
import org.noear.solon.annotation.Mapping;
import org.noear.solon.annotation.Param;
import org.noear.solon.annotation.Path;
import org.noear.solon.annotation.Post;
import site.sorghum.loopra.web.model.ApiResponse;
import site.sorghum.loopra.web.model.SnapshotDTO;
import site.sorghum.loopra.web.model.SnapshotRollbackDTO;
import site.sorghum.loopra.web.model.SnapshotStatusDTO;
import site.sorghum.loopra.web.service.AgentService;
import site.sorghum.loopra.web.service.SnapshotService;

import java.util.ArrayList;
import java.util.List;

/**
 * 快照检查点 API —— 提供项目快照创建、撤回和查询能力。
 * <p>
 * 快照基于 Git 底层命令实现，不污染用户的分支和提交历史：
 * <ul>
 *   <li>createCheckpoint —— AI 修改前保存当前项目状态</li>
 *   <li>rollback —— 撤回 AI 修改，恢复到快照时的状态</li>
 *   <li>list —— 列出所有快照</li>
 * </ul>
 * </p>
 *
 * @author Sorghum
 */
@Api(tags = "快照检查点")
@Controller
@Mapping("/api/snapshots")
public class SnapshotController {

    @Inject
    private SnapshotService snapshotService;

    @Inject
    private AgentService agentService;

    @ApiOperation(value = "创建快照检查点",
            notes = "在 AI 执行代码修改前保存当前项目状态，基于 Git 底层命令实现，不影响提交历史")
    @Post
    @Mapping("/checkpoint")
    public ApiResponse<SnapshotDTO> createCheckpoint(
            @ApiParam(value = "项目 hash") @Param(value = "workspaceHash", required = false) String workspaceHash,
            @ApiParam(value = "消息 ID（用于标识快照）") @Param("msgId") String msgId) {
        if (msgId == null || msgId.trim().isEmpty()) {
            return ApiResponse.fail("msgId 不能为空");
        }
        SnapshotService.SnapshotInfo info = snapshotService.createCheckpoint(workspaceHash, msgId.trim());
        return ApiResponse.ok(new SnapshotDTO(info.getMsgId(), info.getCommitHash(), info.getTreeHash(), info.getCreatedAt()));
    }

    @ApiOperation(value = "撤回到快照",
            notes = "撤回指定消息及之后的会话历史；rollbackCode=true 时同时恢复项目到快照状态")
    @Post
    @Mapping("/rollback")
    public ApiResponse<SnapshotRollbackDTO> rollback(
            @ApiParam(value = "项目 hash") @Param(value = "workspaceHash", required = false) String workspaceHash,
            @ApiParam(value = "要撤回的消息 ID") @Param(value = "msgId", required = false) String msgId,
            @ApiParam(value = "会话名称") @Param(value = "sessionName", required = false) String sessionName,
            @ApiParam(value = "历史消息时间戳（兼容无撤回 ID 的旧消息）") @Param(value = "rollbackTimestamp", required = false) Long rollbackTimestamp,
            @ApiParam(value = "是否同时恢复项目代码，默认 true") @Param(value = "rollbackCode", required = false) Boolean rollbackCode) {
        if ((msgId == null || msgId.trim().isEmpty()) && rollbackTimestamp == null) {
            return ApiResponse.fail("msgId 或 rollbackTimestamp 不能为空");
        }
        String rollbackMsgId = msgId == null ? null : msgId.trim();
        boolean restoreCode = rollbackCode == null || rollbackCode;
        if (restoreCode && (rollbackMsgId == null || rollbackMsgId.isEmpty())) {
            return ApiResponse.fail("撤回代码需要有效的快照 ID");
        }
        SnapshotService.SnapshotRollbackResult result = restoreCode
                ? snapshotService.rollbackToSnapshot(workspaceHash, rollbackMsgId)
                : new SnapshotService.SnapshotRollbackResult(rollbackMsgId, null, null, true, "会话消息已撤回，项目代码未修改");

        // 撤回成功后，截断会话历史（删除该消息及之后的所有消息）
        if (result.isSuccess()) {
            String workspacePath = agentService.resolveProjectPath(workspaceHash);
            String rollbackText = agentService.truncateHistoryBySnapshotId(workspacePath, sessionName, rollbackMsgId, rollbackTimestamp);
            if (!restoreCode && rollbackMsgId != null && !rollbackMsgId.isEmpty()) {
                snapshotService.discardSnapshotsAfter(workspaceHash, rollbackMsgId);
            }
            if (rollbackText != null) {
                // 将被删除的用户消息文本返回给前端，用于回填输入框
                result.setRollbackUserText(rollbackText);
            }
        }
        SnapshotRollbackDTO dto = new SnapshotRollbackDTO(
                result.getMsgId(), result.getCommitHash(), result.getTreeHash(),
                result.isSuccess(), result.getMessage());
        dto.setRollbackUserText(result.getRollbackUserText());
        return ApiResponse.ok(dto);
    }

    @ApiOperation(value = "列出快照", notes = "列出当前项目的所有快照检查点")
    @Get
    @Mapping("")
    public ApiResponse<List<SnapshotDTO>> list(
            @ApiParam(value = "项目 hash") @Param(value = "workspaceHash", required = false) String workspaceHash,
            @ApiParam(value = "会话名称") @Param(value = "sessionName", required = false) String sessionName) {
        List<SnapshotService.SnapshotInfo> snapshots = snapshotService.listSnapshots(workspaceHash, sessionName);
        List<SnapshotDTO> dtos = new ArrayList<>();
        for (SnapshotService.SnapshotInfo info : snapshots) {
            dtos.add(new SnapshotDTO(info.getMsgId(), info.getCommitHash(), info.getTreeHash(), info.getCreatedAt()));
        }
        return ApiResponse.ok(dtos);
    }

    @ApiOperation(value = "检查 Git 仓库状态", notes = "检查当前项目是否为 Git 仓库（创建快照的前提条件）")
    @Get
    @Mapping("/status")
    public ApiResponse<SnapshotStatusDTO> status(
            @ApiParam(value = "项目 hash") @Param(value = "workspaceHash", required = false) String workspaceHash) {
        boolean isGitRepo = snapshotService.isGitRepo(workspaceHash);
        return ApiResponse.ok(new SnapshotStatusDTO(isGitRepo));
    }

    @ApiOperation(value = "删除快照", notes = "删除指定消息的快照引用")
    @Delete
    @Mapping("/{msgId}")
    public ApiResponse<String> delete(
            @ApiParam(value = "消息 ID") @Path("msgId") String msgId,
            @ApiParam(value = "项目 hash") @Param(value = "workspaceHash", required = false) String workspaceHash) {
        snapshotService.deleteSnapshot(workspaceHash, msgId);
        return ApiResponse.ok("快照已删除");
    }
}
