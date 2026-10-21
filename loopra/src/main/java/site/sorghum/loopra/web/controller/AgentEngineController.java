package site.sorghum.loopra.web.controller;

import org.noear.solon.annotation.*;
import site.sorghum.loopra.web.model.ApiResponse;
import site.sorghum.loopra.web.service.AgentService;
import site.sorghum.loopra.web.service.AgentPreferencesService;
import site.sorghum.loopra.web.service.ExternalAcpProviders;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Native plus the installed external ACP providers. */
@Controller
@Mapping("/api/agent-engines")
public class AgentEngineController {
    @Inject private AgentService agents;
    @Inject private AgentPreferencesService preferences;

    @Get @Mapping("/preferences")
    public ApiResponse<AgentPreferencesService.Preferences> preferences() {
        return ApiResponse.ok(preferences.get());
    }

    public record Selection(String selectedAgent) {}
    @Put @Mapping("/preferences")
    public ApiResponse<AgentPreferencesService.Preferences> select(@Body Selection selection) {
        if (selection == null || selection.selectedAgent() == null)
            throw new site.sorghum.loopra.web.common.ServiceException("请选择 Agent");
        return ApiResponse.ok(preferences.select(selection.selectedAgent()));
    }
    @Get @Mapping("")
    public ApiResponse<List<Engine>> list() {
        List<Engine> engines = new ArrayList<>();
        engines.add(new Engine("native", "Loopra Native", agents.isNativeReady(),
                agents.isNativeReady() ? "使用 Loopra 模型配置" : "请配置 Loopra 模型"));
        for (var provider : ExternalAcpProviders.all()) {
            var installation = provider.detect();
            engines.add(new Engine(provider.id(), provider.name(), installation.available(), installation.detail()));
        }
        return ApiResponse.ok(engines);
    }
    @Get @Mapping("/session")
    public ApiResponse<Map<String, Object>> session(@Param(value="workspaceHash", required=true) String hash,
                                                  @Param(value="sessionName", required=true) String name) {
        String workspace = agents.resolveProjectHashOrThrow(hash);
        return ApiResponse.ok(Map.of("agentId", agents.sessionAgentId(workspace, name),
                "hasMessages", !agents.getRawEvents(workspace, name).isEmpty()));
    }
    public record Engine(String id, String name, boolean available, String detail) {}

    @Get @Mapping("/config")
    public ApiResponse<Map<String, Object>> configuration(@Param(value="workspaceHash", required=true) String hash,
                                                         @Param(value="sessionName", required=true) String name) throws Exception {
        return ApiResponse.ok(Map.of("configOptions", agents.agentConfiguration(agents.resolveProjectHashOrThrow(hash), name, null, null)));
    }
    public record ConfigChange(String workspaceHash, String sessionName, String configId, Object value) {}
    public record Prepare(String workspaceHash, String sessionName, String agentId) {}
    @Post @Mapping("/prepare")
    public ApiResponse<Map<String, Object>> prepare(@Body Prepare request) throws Exception {
        if (request == null) throw new site.sorghum.loopra.web.common.ServiceException("请选择项目和 Agent");
        String workspace = agents.resolveProjectHashOrThrow(request.workspaceHash());
        String name = request.sessionName();
        boolean fresh = name == null || name.isBlank();
        if (fresh) name = agents.newSession(workspace, "loopra-" + java.util.UUID.randomUUID(), false);
        agents.selectSessionAgent(workspace, name, request.agentId());
        var options = agents.agentConfiguration(workspace, name, null, null);
        if (fresh) {
            String sessionName = name;
            options = preferences.restore(agents.sessionAgentId(workspace, name), options,
                    (id, value) -> agents.agentConfiguration(workspace, sessionName, id, value));
        }
        return ApiResponse.ok(Map.of("sessionName", name, "agentId", agents.sessionAgentId(workspace, name),
                "configOptions", options));
    }
    @Put @Mapping("/config")
    public ApiResponse<Map<String, Object>> configure(@Body ConfigChange change) throws Exception {
        if (change == null || change.sessionName() == null || change.configId() == null || change.value() == null)
            throw new site.sorghum.loopra.web.common.ServiceException("需要会话、配置 ID 和选项值");
        String workspace = agents.resolveProjectHashOrThrow(change.workspaceHash());
        var options = agents.agentConfiguration(workspace, change.sessionName(), change.configId(), change.value());
        if (!"plan".equals(change.configId()))
            preferences.remember(agents.sessionAgentId(workspace, change.sessionName()), options);
        return ApiResponse.ok(Map.of("configOptions", options));
    }
}
