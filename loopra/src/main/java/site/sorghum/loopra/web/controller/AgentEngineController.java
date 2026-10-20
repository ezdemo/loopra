package site.sorghum.loopra.web.controller;

import org.noear.solon.annotation.*;
import site.sorghum.loopra.web.model.ApiResponse;
import site.sorghum.loopra.web.service.AgentService;
import site.sorghum.loopra.web.service.ExternalAcpProviders;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Native plus the installed external ACP providers. */
@Controller
@Mapping("/api/agent-engines")
public class AgentEngineController {
    @Inject private AgentService agents;
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
        if (name == null || name.isBlank()) name = agents.newSession(workspace, "loopra-" + java.util.UUID.randomUUID(), false);
        agents.selectSessionAgent(workspace, name, request.agentId());
        return ApiResponse.ok(Map.of("sessionName", name, "agentId", agents.sessionAgentId(workspace, name),
                "configOptions", agents.agentConfiguration(workspace, name, null, null)));
    }
    @Put @Mapping("/config")
    public ApiResponse<Map<String, Object>> configure(@Body ConfigChange change) throws Exception {
        if (change == null || change.sessionName() == null || change.configId() == null || change.value() == null)
            throw new site.sorghum.loopra.web.common.ServiceException("需要会话、配置 ID 和选项值");
        return ApiResponse.ok(Map.of("configOptions", agents.agentConfiguration(agents.resolveProjectHashOrThrow(change.workspaceHash()),
                change.sessionName(), change.configId(), change.value())));
    }
}
