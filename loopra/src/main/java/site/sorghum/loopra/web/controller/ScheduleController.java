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
import org.noear.solon.annotation.Param;
import org.noear.solon.annotation.Path;
import org.noear.solon.annotation.Post;
import org.noear.solon.annotation.Put;
import site.sorghum.loopra.bin.schedule.ScheduledTask;
import site.sorghum.loopra.bin.schedule.CronParser;
import site.sorghum.loopra.web.model.ApiResponse;
import site.sorghum.loopra.web.service.AgentService;
import site.sorghum.loopra.web.service.ScheduleManager;

import java.util.List;

/**
 * 定时任务管理 API 控制器。
 * <p>
 * 支持项目级别的定时任务增删改查、启用/禁用、手动触发执行。
 * </p>
 *
 * @author Sorghum
 */
@Slf4j
@Api(tags = "定时任务")
@Controller
@Mapping("/api/schedules")
public class ScheduleController {

    @Inject
    private ScheduleManager scheduleManager;

    @Inject
    private AgentService agentService;

    @ApiOperation(value = "列出定时任务", notes = "返回指定项目下的所有定时任务")
    @Get
    @Mapping("")
    public ApiResponse<List<ScheduledTask>> list(
            @ApiParam(value = "项目 hash", required = true)
            @Param(value = "workspaceHash", required = true) String workspaceHash) {
        return ApiResponse.ok(scheduleManager.list(workspaceHash));
    }

    @ApiOperation(value = "获取单个定时任务", notes = "根据项目和任务 ID 获取定时任务详情")
    @Get
    @Mapping("/{id}")
    public ApiResponse<ScheduledTask> get(
            @ApiParam(value = "项目 hash", required = true)
            @Param(value = "workspaceHash", required = true) String workspaceHash,
            @ApiParam(value = "任务 ID") @Path("id") String id) {
        ScheduledTask task = scheduleManager.get(workspaceHash, id);
        if (task == null) {
            return ApiResponse.fail("定时任务不存在: " + id);
        }
        return ApiResponse.ok(task);
    }

    @ApiOperation(value = "创建定时任务", notes = "在项目下创建一个新的定时任务")
    @Post
    @Mapping("")
    public ApiResponse<ScheduledTask> create(
            @ApiParam(value = "项目 hash", required = true)
            @Param(value = "workspaceHash", required = true) String workspaceHash,
            @Body ScheduledTask task) {
        if (task == null) {
            return ApiResponse.fail("请求体不能为空");
        }
        if (task.getMessage() == null || task.getMessage().isBlank()) {
            return ApiResponse.fail("消息内容不能为空");
        }
        String sessionError = validateSession(task, true);
        if (sessionError != null) return ApiResponse.fail(sessionError);
        String scheduleError = validateSchedule(task, true);
        if (scheduleError != null) return ApiResponse.fail(scheduleError);

        ScheduledTask created = scheduleManager.create(workspaceHash, task);
        log.info("[schedule] 创建定时任务: {} (项目={})", created.getName(), workspaceHash);
        return ApiResponse.ok(created);
    }

    @ApiOperation(value = "更新定时任务", notes = "更新指定定时任务的配置")
    @Put
    @Mapping("/{id}")
    public ApiResponse<ScheduledTask> update(
            @ApiParam(value = "项目 hash", required = true)
            @Param(value = "workspaceHash", required = true) String workspaceHash,
            @ApiParam(value = "任务 ID") @Path("id") String id,
            @Body ScheduledTask update) {
        if (update == null) {
            return ApiResponse.fail("请求体不能为空");
        }
        String sessionError = validateSession(update, false);
        if (sessionError != null) return ApiResponse.fail(sessionError);
        String scheduleError = validateSchedule(update, false);
        if (scheduleError != null) return ApiResponse.fail(scheduleError);
        ScheduledTask updated = scheduleManager.update(workspaceHash, id, update);
        if (updated == null) {
            return ApiResponse.fail("定时任务不存在: " + id);
        }
        log.info("[schedule] 更新定时任务: {} (项目={})", updated.getName(), workspaceHash);
        return ApiResponse.ok(updated);
    }

    @ApiOperation(value = "启用/禁用定时任务", notes = "切换定时任务的启用状态")
    @Post
    @Mapping("/{id}/toggle")
    public ApiResponse<ScheduledTask> toggle(
            @ApiParam(value = "项目 hash", required = true)
            @Param(value = "workspaceHash", required = true) String workspaceHash,
            @ApiParam(value = "任务 ID") @Path("id") String id) {
        ScheduledTask toggled = scheduleManager.toggle(workspaceHash, id);
        if (toggled == null) {
            return ApiResponse.fail("定时任务不存在: " + id);
        }
        log.info("[schedule] 切换定时任务状态: {} → enabled={} (项目={})",
                toggled.getName(), toggled.isEnabled(), workspaceHash);
        return ApiResponse.ok(toggled);
    }

    @ApiOperation(value = "手动触发执行", notes = "立即执行指定定时任务一次")
    @Post
    @Mapping("/{id}/run")
    public ApiResponse<String> runNow(
            @ApiParam(value = "项目 hash", required = true)
            @Param(value = "workspaceHash", required = true) String workspaceHash,
            @ApiParam(value = "任务 ID") @Path("id") String id) {
        String result = scheduleManager.runNow(workspaceHash, id);
        if (result == null) {
            return ApiResponse.fail("定时任务不存在: " + id);
        }
        log.info("[schedule] 手动触发执行定时任务: {} (项目={})", id, workspaceHash);
        return ApiResponse.ok(result);
    }

    @ApiOperation(value = "删除定时任务", notes = "删除指定定时任务")
    @Delete
    @Mapping("/{id}")
    public ApiResponse<String> delete(
            @ApiParam(value = "项目 hash", required = true)
            @Param(value = "workspaceHash", required = true) String workspaceHash,
            @ApiParam(value = "任务 ID") @Path("id") String id) {
        scheduleManager.delete(workspaceHash, id);
        log.info("[schedule] 删除定时任务: {} (项目={})", id, workspaceHash);
        return ApiResponse.ok("已删除");
    }

    private String validateSchedule(ScheduledTask task, boolean required) {
        String cron = task.getCronExpr();
        Long interval = task.getIntervalSec();
        if (cron != null && !cron.isBlank()) {
            return CronParser.nextTime(cron, System.currentTimeMillis()) > 0 ? null : "Cron 表达式无效";
        }
        if (interval != null) return interval > 0 ? null : "执行间隔必须大于 0 秒";
        return required || cron != null ? "请选择有效的执行时间" : null;
    }

    private String validateSession(ScheduledTask task, boolean required) {
        String mode = task.getSessionMode();
        if (mode != null && !mode.isBlank() && !"independent".equals(mode) && !"existing".equals(mode)) {
            return "无效的会话方式";
        }
        if ("independent".equals(mode)) return null;
        if (required || "existing".equals(mode) || task.getSessionName() != null) {
            if (task.getSessionName() == null || task.getSessionName().isBlank()) return "目标会话名称不能为空";
        }
        return null;
    }
}
