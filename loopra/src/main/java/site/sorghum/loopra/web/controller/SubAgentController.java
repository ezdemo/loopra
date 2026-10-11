package site.sorghum.loopra.web.controller;

import io.swagger.annotations.Api;
import io.swagger.annotations.ApiOperation;
import org.noear.solon.ai.chat.tool.FunctionTool;
import org.noear.solon.annotation.Body;
import org.noear.solon.annotation.Controller;
import org.noear.solon.annotation.Get;
import org.noear.solon.annotation.Inject;
import org.noear.solon.annotation.Mapping;
import org.noear.solon.annotation.Put;
import site.sorghum.loopra.bin.agent.core.SubAgent;
import site.sorghum.loopra.bin.builtin.SubAgentProfileConfig;
import site.sorghum.loopra.bin.builtin.SubAgentProfileStore;
import site.sorghum.loopra.bin.tool.ToolRegistry;
import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.common.WebErrorMessages;
import site.sorghum.loopra.web.model.ApiResponse;
import site.sorghum.loopra.web.model.SubAgentInfoDTO;
import site.sorghum.loopra.web.service.AgentService;

import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** 子代理配置与运行时信息管理接口。 */
@Api(tags = "子代理")
@Controller
@Mapping("/api/sub-agents")
public class SubAgentController {

    @Inject
    private AgentService agentService;

    @Inject
    private SubAgentProfileStore profileStore;

    @ApiOperation(value = "列出子代理", notes = "返回全部子代理（含已禁用，便于前端重新启用）及其当前实际可用的工具")
    @Get
    @Mapping("")
    public ApiResponse<List<SubAgentInfoDTO>> list() {
        if (!agentService.isReady()) throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        ToolRegistry registry = agentService.getSharedToolRegistry();
        registry.refresh();
        Collection<FunctionTool> enabledTools = registry.all().values();
        List<SubAgentInfoDTO> profiles = new ArrayList<>();
        for (SubAgentProfileConfig profile : profileStore.allIncludingDisabled()) {
            profiles.add(toSubAgentInfoDTO(profile, enabledTools));
        }
        return ApiResponse.ok(profiles);
    }

    @ApiOperation(value = "保存子代理配置", notes = "全量保存角色列表（含新增、修改、禁用），id 必填且不可重复")    @Put
    @Mapping("")
    public ApiResponse<List<SubAgentInfoDTO>> save(@Body Map<String, Object> body) {
        if (!agentService.isReady()) throw new ServiceException(WebErrorMessages.AGENT_NOT_READY);
        Object rawProfiles = body == null ? null : body.get("profiles");
        if (!(rawProfiles instanceof List<?> submitted)) {
            return ApiResponse.fail("子代理角色数据格式不正确");
        }
        List<SubAgentProfileConfig> configs = new ArrayList<>();
        for (Object item : submitted) {
            if (!(item instanceof Map<?, ?> map)) {
                return ApiResponse.fail("子代理角色数据格式不正确");
            }
            configs.add(toProfileConfig(map));
        }
        try {
            profileStore.save(configs);
        } catch (IllegalArgumentException e) {
            return ApiResponse.fail(e.getMessage());
        } catch (IllegalStateException e) {
            return ApiResponse.fail(e.getMessage());
        }
        ToolRegistry registry = agentService.getSharedToolRegistry();
        registry.refresh();
        Collection<FunctionTool> enabledTools = registry.all().values();
        return ApiResponse.ok(configs.stream()
                .map(config -> toSubAgentInfoDTO(config, enabledTools))
                .toList());
    }

    @ApiOperation(value = "子代理不可用工具清单", notes = "返回子代理无法使用的工具名（主代理专用工具）")
    @Get
    @Mapping("/denied-tools")
    public ApiResponse<List<String>> deniedTools() {
        return ApiResponse.ok(SubAgent.SUB_AGENT_DENY.stream().sorted().toList());
    }

    private static SubAgentProfileConfig toProfileConfig(Map<?, ?> map) {
        SubAgentProfileConfig config = new SubAgentProfileConfig();
        config.id = text(map.get("id"));
        config.name = text(map.get("name"));
        config.description = text(map.get("description"));
        config.instructions = text(map.get("instructions"));
        Object enable = map.get("enable");
        config.enable = enable == null ? Boolean.TRUE : Boolean.parseBoolean(enable.toString());
        Object readOnly = map.get("readOnly");
        config.readOnly = readOnly != null && Boolean.parseBoolean(readOnly.toString());
        Object rawTools = map.get("allowedTools");
        if (rawTools instanceof List<?> toolList) {
            config.allowedTools = toolList.stream()
                    .map(Object::toString)
                    .map(String::trim)
                    .filter(tool -> !tool.isEmpty())
                    .toList();
        }
        config.modelChannel = text(map.get("modelChannel"));
        config.model = text(map.get("model"));
        return config;
    }

    private static String text(Object value) {
        return value == null ? null : value.toString().trim();
    }

    static SubAgentInfoDTO toSubAgentInfoDTO(SubAgentProfileConfig profile, Collection<FunctionTool> enabledTools) {
        List<FunctionTool> availableTools = enabledTools == null ? List.of() : enabledTools.stream()
                .filter(tool -> !SubAgent.SUB_AGENT_DENY.contains(tool.name()))
                .toList();
        Set<String> allowedTools = profile.allowedTools(availableTools);
        List<String> tools = availableTools.stream()
                .map(FunctionTool::name)
                .filter(name -> allowedTools == null || allowedTools.contains(name))
                .sorted(Comparator.naturalOrder())
                .toList();
        return new SubAgentInfoDTO(profile.id(), profile.name(), profile.description(), profile.readOnly(),
                profile.instructions(), tools, profile.allowedTools, profile.enable, SubAgentProfileStore.isBuiltin(profile.id()),
                profile.modelChannel, profile.model);
    }
}
