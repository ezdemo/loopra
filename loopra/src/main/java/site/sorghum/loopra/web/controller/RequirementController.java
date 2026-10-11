package site.sorghum.loopra.web.controller;

import io.swagger.annotations.Api;
import io.swagger.annotations.ApiOperation;
import io.swagger.annotations.ApiParam;
import lombok.extern.slf4j.Slf4j;
import org.noear.solon.annotation.Body;
import org.noear.solon.annotation.Controller;
import org.noear.solon.annotation.Delete;
import org.noear.solon.annotation.Get;
import org.noear.solon.annotation.Inject;
import org.noear.solon.annotation.Mapping;
import org.noear.solon.annotation.Path;
import org.noear.solon.annotation.Post;
import org.noear.solon.annotation.Put;
import site.sorghum.loopra.bin.agent.model.ChatMessage;
import site.sorghum.loopra.bin.requirement.Requirement;
import site.sorghum.loopra.web.model.ApiResponse;
import site.sorghum.loopra.web.service.AgentService;
import site.sorghum.loopra.web.service.RequirementManager;

import java.util.List;
import java.util.Map;

/**
 * 需求池管理 API 控制器。
 * <p>
 * 需求增删改查、评论（写入专属会话）、消息流拉取；
 * 执行触发（run/abort）由执行器阶段提供。
 * </p>
 *
 * @author Sorghum
 */
@Slf4j
@Api(tags = "需求池")
@Controller
@Mapping("/api/requirements")
public class RequirementController {

    @Inject
    private RequirementManager requirementManager;

    @Inject
    private AgentService agentService;

    @ApiOperation(value = "列出所有需求", notes = "返回全部需求（按创建顺序）")
    @Get
    @Mapping("")
    public ApiResponse<List<Requirement>> list() {
        return ApiResponse.ok(requirementManager.list());
    }

    @ApiOperation(value = "创建需求", notes = "title 与 projectHash 必填，创建后自动生成专属执行会话")
    @Post
    @Mapping("")
    public ApiResponse<Requirement> create(@Body Requirement draft) {
        if (draft == null) {
            return ApiResponse.fail("请求体不能为空");
        }
        if (draft.getTitle() == null || draft.getTitle().isBlank()) {
            return ApiResponse.fail("需求标题不能为空");
        }
        if (draft.getProjectHash() == null || draft.getProjectHash().isBlank()) {
            return ApiResponse.fail("必须选择项目");
        }
        String scheduleMode = draft.getScheduleMode();
        if (scheduleMode != null && !scheduleMode.isBlank()
                && !"immediate".equals(scheduleMode) && !"scheduled".equals(scheduleMode)) {
            return ApiResponse.fail("不支持的调度方式: " + scheduleMode);
        }
        if ("scheduled".equals(scheduleMode) && draft.getScheduledAt() <= System.currentTimeMillis()) {
            return ApiResponse.fail("定时执行时间必须晚于当前时间");
        }
        if (agentService.resolveProjectPath(draft.getProjectHash()) == null) {
            return ApiResponse.fail("项目不存在: " + draft.getProjectHash());
        }
        Requirement created = requirementManager.create(draft);
        log.info("[requirement] 创建需求: {} (项目={})", created.getTitle(), created.getProjectName());
        return ApiResponse.ok(created);
    }

    @ApiOperation(value = "更新需求", notes = "仅可更新描述与优先级，标题与状态不可改")
    @Put
    @Mapping("/{id}")
    public ApiResponse<Requirement> update(
            @ApiParam(value = "需求 ID") @Path("id") String id,
            @Body Requirement update) {
        if (update == null) {
            return ApiResponse.fail("请求体不能为空");
        }
        Requirement updated = requirementManager.update(id, update);
        if (updated == null) {
            return ApiResponse.fail("需求不存在: " + id);
        }
        return ApiResponse.ok(updated);
    }

    @ApiOperation(value = "删除需求", notes = "不级联删除执行会话")
    @Delete
    @Mapping("/{id}")
    public ApiResponse<String> delete(@ApiParam(value = "需求 ID") @Path("id") String id) {
        if (!requirementManager.delete(id)) {
            return ApiResponse.fail("需求不存在: " + id);
        }
        log.info("[requirement] 删除需求: {}", id);
        return ApiResponse.ok("已删除");
    }

    @ApiOperation(value = "追加评论", notes = "评论作为 user 消息写入需求专属会话（对 AI 可见）")
    @Post
    @Mapping("/{id}/comments")
    public ApiResponse<String> addComment(
            @ApiParam(value = "需求 ID") @Path("id") String id,
            @Body Map<String, String> body) {
        String text = body == null ? null : body.get("text");
        if (text == null || text.isBlank()) {
            return ApiResponse.fail("评论内容不能为空");
        }
        if (!requirementManager.addComment(id, text.trim())) {
            return ApiResponse.fail("需求不存在或所属项目不可用: " + id);
        }
        return ApiResponse.ok("已提交");
    }

    @ApiOperation(value = "拉取需求消息流", notes = "需求专属会话的完整消息流（评论 + 执行日志）")
    @Get
    @Mapping("/{id}/messages")
    public ApiResponse<List<ChatMessage>> getMessages(@ApiParam(value = "需求 ID") @Path("id") String id) {
        List<ChatMessage> messages = requirementManager.getMessages(id);
        if (messages == null) {
            return ApiResponse.fail("需求不存在: " + id);
        }
        return ApiResponse.ok(messages);
    }

    @ApiOperation(value = "触发执行", notes = "todo/failed 需求入队执行（并发上限 2），状态流转为 doing")
    @Post
    @Mapping("/{id}/run")
    public ApiResponse<String> run(@ApiParam(value = "需求 ID") @Path("id") String id) {
        String result = requirementManager.run(id);
        return switch (result) {
            case "started" -> ApiResponse.ok("已入队执行");
            case "busy" -> ApiResponse.fail("需求正在执行或状态不允许触发: " + id);
            default -> ApiResponse.fail("需求不存在: " + id);
        };
    }

    @ApiOperation(value = "处理待审批工具调用", notes = "审批模式下在原需求会话继续执行")
    @Post
    @Mapping("/{id}/approval")
    public ApiResponse<String> resolveApproval(
            @ApiParam(value = "需求 ID") @Path("id") String id,
            @Body Map<String, String> body) {
        String action = body == null ? null : body.get("action");
        if (!"approve".equals(action) && !"deny".equals(action)) {
            return ApiResponse.fail("审批操作必须为 approve 或 deny");
        }
        if (!requirementManager.resolveApproval(id, "approve".equals(action))) {
            return ApiResponse.fail("需求不存在、未在执行中或没有待审批操作: " + id);
        }
        return ApiResponse.ok("已" + ("approve".equals(action) ? "同意" : "拒绝") + "，AI 将继续执行");
    }

    @ApiOperation(value = "取消执行", notes = "中断会话并将状态回退到 todo")
    @Post
    @Mapping("/{id}/abort")
    public ApiResponse<String> abort(@ApiParam(value = "需求 ID") @Path("id") String id) {
        if (!requirementManager.abort(id)) {
            return ApiResponse.fail("需求不存在: " + id);
        }
        return ApiResponse.ok("已取消");
    }
}
