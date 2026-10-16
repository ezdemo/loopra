package site.sorghum.loopra.web.controller;

import org.noear.dami2.Dami;
import org.noear.solon.ai.chat.tool.FunctionTool;
import org.noear.solon.annotation.Body;
import org.noear.solon.annotation.Controller;
import org.noear.solon.annotation.Get;
import org.noear.solon.annotation.Inject;
import org.noear.solon.annotation.Mapping;
import org.noear.solon.annotation.Path;
import org.noear.solon.annotation.Post;
import site.sorghum.loopra.bin.config.ConfigChangedEvent;
import site.sorghum.loopra.bin.config.ConfigService;
import site.sorghum.loopra.bin.tool.ToolMetadata;
import site.sorghum.loopra.bin.tool.ToolRegistry;
import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.common.WebErrorMessages;
import site.sorghum.loopra.web.model.ApiResponse;
import site.sorghum.loopra.web.model.ToolInfoDTO;
import site.sorghum.loopra.web.model.ToolParamInfoDTO;
import site.sorghum.loopra.web.service.AgentService;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import io.swagger.annotations.Api;
import io.swagger.annotations.ApiOperation;
import io.swagger.annotations.ApiParam;

/** 工具管理接口：查询、启用/禁用、审批与只读覆盖。 */
@Api(tags = "工具管理")
@Controller
@Mapping("/api/tools")
public class ToolController {

    @Inject
    private AgentService agentService;

    static ToolInfoDTO toToolInfoDTO(FunctionTool def, boolean enabled, boolean autoApproved) {
        List<ToolParamInfoDTO> params = new ArrayList<>();
        return new ToolInfoDTO(def.name(), def.description(),
                ToolMetadata.isReadOnly(def), ToolMetadata.readOnlyOverride(def), ToolMetadata.isStormExempt(def),
                enabled, autoApproved, params);
    }

    @ApiOperation(value = "列出所有工具", notes = "返回所有已注册的 Agent 工具列表（含已禁用的），含启用状态")
    @Get
    @Mapping("")
    public ApiResponse<List<ToolInfoDTO>> list() {
        if (!agentService.isReady()) throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        List<ToolInfoDTO> tools = new ArrayList<>();
        ToolRegistry registry = agentService.getSharedToolRegistry();
        registry.refresh();
        Map<String, FunctionTool> allTools = registry.allScanned();
        List<String> autoWhitelist = ConfigService.getAutoWhitelist();
        if (allTools != null) {
            for (FunctionTool def : allTools.values()) {
                boolean enabled = registry.isEnabled(def.name());
                boolean autoApproved = autoWhitelist.contains(def.name());
                tools.add(toToolInfoDTO(def, enabled, autoApproved));
            }
        }
        return ApiResponse.ok(tools);
    }

    @ApiOperation(value = "切换工具启用/禁用状态", notes = "启用或禁用指定工具，实时生效")
    @Post
    @Mapping("/{name}/toggle")
    public ApiResponse<String> toggle(@ApiParam(value = "工具名称") @Path("name") String name) {
        ToolRegistry registry = requireToolRegistry(name);
        boolean currentlyEnabled = registry.isEnabled(name);
        Set<String> newDisabled = new HashSet<>(ConfigService.getDisabledTools());
        if (currentlyEnabled) {
            newDisabled.add(name);
            ConfigService.addDisabledTools(Collections.singletonList(name));
        } else {
            newDisabled.remove(name);
            ConfigService.removeDisabledTools(Collections.singletonList(name));
        }
        registry.setDisabledTools(newDisabled);
        registry.refresh();
        Dami.bus().send("config.changed", new ConfigChangedEvent("disabledTools",
                currentlyEnabled ? Collections.singletonList(name) : null));
        return ApiResponse.ok(currentlyEnabled ? "已禁用工具: " + name : "已启用工具: " + name);
    }

    @ApiOperation(value = "切换工具自动放行状态", notes = "在 HITL 自动模式下，自动放行的工具无需用户审批")
    @Post
    @Mapping("/{name}/auto-toggle")
    public ApiResponse<String> autoToggle(@ApiParam(value = "工具名称") @Path("name") String name) {
        requireToolRegistry(name);
        List<String> autoWhitelist = ConfigService.getAutoWhitelist();
        boolean currentlyAutoApproved = autoWhitelist.contains(name);
        if (currentlyAutoApproved) {
            ConfigService.removeAutoWhitelist(Collections.singletonList(name));
        } else {
            ConfigService.addAutoWhitelist(Collections.singletonList(name));
        }
        return ApiResponse.ok(currentlyAutoApproved ? "已移除自动放行: " + name : "已添加自动放行: " + name);
    }

    @ApiOperation(value = "设置工具只读分类", notes = "设置为只读或写入；readOnly 为 null 时恢复工具默认分类")
    @Post
    @Mapping("/{name}/read-only")
    public ApiResponse<String> setReadOnly(
            @ApiParam(value = "工具名称") @Path("name") String name,
            @Body ToolReadOnlyRequest request) {
        ToolRegistry registry = requireToolRegistry(name);
        Boolean readOnly = request != null ? request.readOnly : null;
        ConfigService.setToolReadOnlyOverride(name, readOnly);
        registry.refresh();
        Dami.bus().send("config.changed", new ConfigChangedEvent("toolReadOnlyOverrides", name));
        String classification = readOnly == null ? "默认" : (readOnly ? "只读" : "写入");
        return ApiResponse.ok("已将工具分类设置为" + classification + ": " + name);
    }

    @ApiOperation(value = "获取工具详情", notes = "根据工具名称获取详细的参数定义和描述")
    @Get
    @Mapping("/{name}")
    public ApiResponse<ToolInfoDTO> get(@ApiParam(value = "工具名称") @Path("name") String name) {
        if (!agentService.isReady()) throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        ToolRegistry registry = agentService.getSharedToolRegistry();
        FunctionTool tool = registry.allScanned().get(name);
        if (tool == null) throw new ServiceException("工具不存在: " + name);
        boolean enabled = registry.isEnabled(name);
        boolean autoApproved = ConfigService.getAutoWhitelist().contains(name);
        return ApiResponse.ok(toToolInfoDTO(tool, enabled, autoApproved));
    }

    private ToolRegistry requireToolRegistry(String name) {
        if (!agentService.isReady()) throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        ToolRegistry registry = agentService.getSharedToolRegistry();
        registry.refresh();
        Map<String, FunctionTool> allTools = registry.allScanned();
        if (allTools == null || !allTools.containsKey(name)) {
            throw new ServiceException("工具不存在: " + name);
        }
        return registry;
    }

    public static class ToolReadOnlyRequest {
        public Boolean readOnly;
    }
}
