package site.sorghum.loopra.bin.builtin;

import org.noear.solon.ai.annotation.ToolMapping;
import org.noear.solon.ai.chat.tool.AbsToolProvider;
import org.noear.solon.ai.chat.tool.FunctionTool;
import org.noear.solon.annotation.Component;
import org.noear.solon.annotation.Inject;
import org.noear.solon.annotation.Param;
import site.sorghum.loopra.tool.SolonToTools;
import site.sorghum.loopra.tool.ToolContext;
import site.sorghum.loopra.bin.project.ProjectRuntimeAccess;

import java.nio.file.Path;
import java.util.Collection;

/** 重新加载当前项目 MCP 配置的 Agent 工具。 */
@Component
public class McpRefreshTool extends AbsToolProvider implements SolonToTools {

    @Inject
    private ProjectRuntimeAccess projectRuntime;

    @ToolMapping(name = "mcprefresh", description = """
            重新加载当前项目 .loopra/mcp-servers.json 中的 MCP 配置。
            当用户在本地新增、删除或修改项目 MCP 后调用。本轮对话结束后自动重建 MCP 连接，
            下一条消息即可使用最新工具；调用后不要假设本轮已经出现新增 MCP 工具。
            """)
    public String refresh(@Param(name = "ctx", required = false) ToolContext ctx) {
        if (ctx == null) {
            return "WORKSPACE_MISSING: 无法确定当前项目，不能刷新 MCP";
        }
        Path projectRoot = ctx.getStateRootDir();
        if (projectRoot == null) {
            return "WORKSPACE_MISSING: 无法确定当前项目，不能刷新 MCP";
        }
        if (projectRuntime == null) {
            return "MCP_REFRESH_UNAVAILABLE: Agent 服务尚未初始化";
        }
        return projectRuntime.requestProjectMcpRefresh(projectRoot.toString());
    }

    @Override
    public Collection<FunctionTool> getSolonTools() {
        return getTools();
    }
}
