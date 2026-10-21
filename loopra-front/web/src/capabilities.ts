// Project capability summary ported from legacy `components/ProjectCapabilitiesPanel.vue`:
// the backend reports which project-local skills and MCP servers a session can see.
export type ProjectSkill = { name?: string; description?: string; scope?: string; mountAlias?: string; path?: string };
export type ProjectMcpServer = { name?: string; type?: string; enabled?: boolean; loaded?: boolean; toolCount?: number; toolNames?: string[]; error?: string };
export type ProjectCapabilitiesData = {
  workspacePath?: string; mcpConfigPath?: string; mcpConfigExists?: boolean;
  projectSkillsPath?: string; projectSkillsDirectoryExists?: boolean;
  skills?: ProjectSkill[]; mcpServers?: ProjectMcpServer[];
};

/** `refresh` hits POST /agent/project-capabilities/refresh, which reloads `.loopra`. */
export const projectCapabilitiesPath = (workspaceHash: string, refresh = false) =>
  `/agent/project-capabilities${refresh ? '/refresh' : ''}?workspaceHash=${encodeURIComponent(workspaceHash)}`;

/** Only `.loopra/skills` entries belong to this project; global skills are listed in settings. */
export const projectSkillsOf = (data?: ProjectCapabilitiesData | null) => (data?.skills || []).filter(skill => skill.scope === 'project');
export const mcpServersOf = (data?: ProjectCapabilitiesData | null) => data?.mcpServers || [];
export const mcpToolCount = (servers: ProjectMcpServer[]) => servers.reduce((total, server) => total + (server.toolCount || 0), 0);

export function filterProjectCapabilities(data: ProjectCapabilitiesData | undefined, search: string) {
  const query = search.trim().toLocaleLowerCase();
  const matches = (values: (string | undefined)[]) => !query || values.some(value => value?.toLocaleLowerCase().includes(query));
  return {
    skills: projectSkillsOf(data).filter(skill => matches([skill.name, skill.description, skill.path])),
    servers: mcpServersOf(data).filter(server => matches([server.name, mcpTypeLabel(server.type), ...(server.toolNames || [])])),
  };
}

export function mcpTypeLabel(type?: string) {
  const labels: Record<string, string> = { stdio: 'stdio', sse: 'SSE', streamable: 'Streamable HTTP', http: 'HTTP' };
  return (type && labels[type]) || type || 'MCP';
}

export function mcpStatusLabel(server: ProjectMcpServer) {
  if (server.enabled === false) return '已禁用';
  if (server.loaded) return '已连接';
  return server.error ? '加载失败' : '未加载';
}

export function projectSkillEmptyText(data?: ProjectCapabilitiesData | null) {
  return data?.projectSkillsDirectoryExists ? '目录中暂无 SKILL.md' : '未找到 .loopra/skills/';
}

export function mcpEmptyText(data?: ProjectCapabilitiesData | null) {
  return data?.mcpConfigExists ? '配置文件存在，但没有可用服务器' : '未找到 .loopra/mcp-servers.json';
}
