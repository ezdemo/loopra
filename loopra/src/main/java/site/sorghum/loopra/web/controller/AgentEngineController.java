package site.sorghum.loopra.web.controller;

import org.noear.solon.annotation.*;
import site.sorghum.loopra.bin.acp.AcpMcpServers;
import site.sorghum.loopra.bin.agent.environment.ChatMode;
import site.sorghum.loopra.bin.mcp.AgentMcpPreferences;
import site.sorghum.loopra.bin.mcp.McpProjectConfig;
import site.sorghum.loopra.web.common.ServiceException;
import site.sorghum.loopra.web.model.ApiResponse;
import site.sorghum.loopra.web.service.AgentService;
import site.sorghum.loopra.web.service.AgentPreferencesService;
import site.sorghum.loopra.web.service.ExternalAcpProviders;
import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/** Native plus the installed external ACP providers. */
@Controller
@Mapping("/api/agent-engines")
public class AgentEngineController {
    @Inject private AgentService agents;
    @Inject private AgentPreferencesService preferences;

    public record McpServerChoice(String name, String type, String source, boolean configuredEnabled, boolean enabled) {}
    public record McpChange(String agentId, String workspaceHash, String name, Boolean enabled) {}

    @Get @Mapping("/mcp")
    public ApiResponse<List<McpServerChoice>> mcp(
            @Param(value="agentId", required=true) String agentId,
            @Param(value="workspaceHash", required=true) String hash) {
        ExternalAcpProviders.isExternal(agentId);
        Path workspace = Path.of(agents.resolveProjectHashOrThrow(hash));
        if (ChatMode.isChatRoot(workspace)) return ApiResponse.ok(List.of());
        try {
            var global = Path.of(System.getProperty("user.home"), ".loopra", McpProjectConfig.CONFIG_FILE);
            var project = McpProjectConfig.read(McpProjectConfig.path(workspace));
            var choices = AgentMcpPreferences.choices(agentId);
            List<McpServerChoice> result = new ArrayList<>();
            AcpMcpServers.definitions(global, workspace).forEach((name, parameters) -> {
                if (parameters != null) result.add(new McpServerChoice(name, parameters.getTypeOrTransport(),
                        project.containsKey(name) ? "project" : "global", parameters.isEnabled(),
                        choices.getOrDefault(name, parameters.isEnabled())));
            });
            return ApiResponse.ok(result);
        } catch (IOException | RuntimeException e) {
            throw new ServiceException("读取 Agent MCP 列表失败，请检查 MCP 配置");
        }
    }

    @Put @Mapping("/mcp")
    public ApiResponse<List<McpServerChoice>> configureMcp(@Body McpChange change) {
        if (change == null || change.enabled() == null || change.name() == null || change.name().isBlank())
            throw new ServiceException("需要 Agent、MCP 名称和启用状态");
        var available = mcp(change.agentId(), change.workspaceHash()).getData();
        if (available.stream().noneMatch(item -> item.name().equals(change.name())))
            throw new ServiceException("MCP 配置不存在，请刷新后重试");
        AgentMcpPreferences.set(AgentMcpPreferences.path(), change.agentId(), change.name(), change.enabled());
        return mcp(change.agentId(), change.workspaceHash());
    }

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
