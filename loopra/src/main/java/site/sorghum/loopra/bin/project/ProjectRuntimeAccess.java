package site.sorghum.loopra.bin.project;

import site.sorghum.loopra.bin.tool.ToolRegistry;

/** 工具与 MCP 所需的项目运行时能力，由应用层提供。 */
public interface ProjectRuntimeAccess {
    ToolRegistry getSharedToolRegistry();

    String getCurrentProject();

    String requestProjectMcpRefresh(String workspacePath);
}
