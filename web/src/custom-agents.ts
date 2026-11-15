import type { CustomAgent, CustomAgentCatalog, CustomAgentCatalogTool, Workspace } from './backend';
import { CHAT_WORKSPACE } from './backend';

/** 只统计真实项目：kind 为 'project'，或历史数据里没有 kind 的工作区。 */
export const isProjectWorkspace = (workspace?: Pick<Workspace, 'kind'> | null) => !workspace?.kind || workspace.kind === 'project';
export const isAgentWorkspace = (workspace?: Pick<Workspace, 'kind'> | null) => workspace?.kind === 'agent';
/** 聊天域工作区：内置纯聊天，或未绑定项目的自定义智能体。它隐藏文件/Git/@引用/MCP/关联项目等能力。 */
export const isChatScoped = (workspace?: Pick<Workspace, 'kind' | 'agent' | 'hash'> | null) =>
  workspace?.hash === CHAT_WORKSPACE.hash || (isAgentWorkspace(workspace) && !workspace?.agent?.projectHash);

export const AGENT_NAME_MAX_RUNES = 40;
export const AGENT_INSTRUCTION_MAX_RUNES = 20000;
export const AGENT_ICON_MAX_BYTES = 128 << 10;

/** 编辑器草稿：mode 为 'default' 时对应后端 null（不限制），'custom' 时对应显式数组。 */
export type AgentDraft = {
  name: string;
  instruction: string;
  projectHash: string;
  icon: string;
  toolsMode: 'default' | 'custom';
  tools: string[];
  skillsMode: 'default' | 'custom';
  skills: string[];
  connectorsMode: 'default' | 'custom';
  connectors: string[];
};

export const emptyAgentDraft: AgentDraft = { name: '', instruction: '', projectHash: '', icon: '', toolsMode: 'default', tools: [], skillsMode: 'default', skills: [], connectorsMode: 'default', connectors: [] };

export function draftFromAgent(agent: CustomAgent): AgentDraft {
  return {
    name: agent.name,
    instruction: agent.instruction,
    projectHash: agent.projectHash,
    icon: agent.icon || '',
    toolsMode: agent.tools === null ? 'default' : 'custom',
    tools: agent.tools ?? [],
    skillsMode: agent.skills === null ? 'default' : 'custom',
    skills: agent.skills ?? [],
    connectorsMode: agent.connectors === null ? 'default' : 'custom',
    connectors: agent.connectors ?? [],
  };
}

export function agentWorkspaceOf(workspace: Workspace | undefined): CustomAgent | undefined {
  return isAgentWorkspace(workspace) ? workspace?.agent : undefined;
}

export const normalizeAgentName = (name: string) => name.trim();

/** 校验持久化的草稿角色：仅在列表真正加载完成后才判定存在性，加载中与拉取失败都保留草稿。 */
export function validDraftAgentId(id: string, agents: CustomAgent[], loaded: boolean): boolean {
  if (!id || !loaded) return true;
  return agents.some(agent => agent.id === id);
}

/** 与后端校验一致：去空白后 1–40 个字符。返回 '' 表示合法。 */
export function agentNameError(name: string): string {
  const length = [...normalizeAgentName(name)].length;
  if (!length) return '请输入智能体名称';
  if (length > AGENT_NAME_MAX_RUNES) return `名称最多 ${AGENT_NAME_MAX_RUNES} 个字符`;
  return '';
}

/** 请求体保持 null（默认）与数组（自定义）的区分。 */
export function agentPayload(draft: AgentDraft): { name: string; instruction: string; projectHash: string; icon: string; tools: string[] | null; skills: string[] | null; connectors: string[] | null } {
  return {
    name: normalizeAgentName(draft.name),
    instruction: draft.instruction,
    projectHash: draft.projectHash,
    icon: draft.icon,
    tools: draft.toolsMode === 'custom' ? [...draft.tools] : null,
    skills: draft.skillsMode === 'custom' ? [...draft.skills] : null,
    connectors: draft.connectorsMode === 'custom' ? [...draft.connectors] : null,
  };
}

/** 图标值是上传图片、Emoji 还是内置图标名，决定 PersonaIcon 的渲染方式。 */
export const isAgentIconImage = (icon: string) => icon.startsWith('data:image/');

/** Emoji 输入只保留最后一个字素簇，输入即视为一次「挑选」。 */
export function emojiIconValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const parts = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(trimmed)];
    if (parts.length) return parts[parts.length - 1].segment;
  }
  return [...trimmed].slice(-1).join('');
}

const ICON_RASTER_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/bmp'];
const ICON_TYPES = [...ICON_RASTER_TYPES, 'image/apng', 'image/gif', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/svg+xml'];

/** 不超过上限的图片按原格式保留（含动图与 SVG）；超限位图居中裁成 96×96 PNG。 */
export async function readAgentIcon(file: File): Promise<string> {
  if (!ICON_TYPES.includes(file.type)) throw new Error('format');
  if (file.size <= AGENT_ICON_MAX_BYTES) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
  if (!ICON_RASTER_TYPES.includes(file.type)) throw new Error('size');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 96;
    const context = canvas.getContext('2d');
    if (!context || !image.naturalWidth || !image.naturalHeight) throw new Error('image');
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 96, 96);
    const result = canvas.toDataURL('image/png');
    if ((result.length - 'data:image/png;base64,'.length) * 3 / 4 > AGENT_ICON_MAX_BYTES) throw new Error('size');
    return result;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function toggleValue(list: string[], value: string, on: boolean): string[] {
  const has = list.includes(value);
  if (on === has) return list;
  return on ? [...list, value] : list.filter(item => item !== value);
}

/** 项目切换后，只保留新工具目录里仍然存在的勾选。 */
export function pruneTools(selected: string[], tools: CustomAgentCatalogTool[]): string[] {
  const names = new Set(tools.map(tool => tool.name));
  return selected.filter(name => names.has(name));
}

/** 只保留目录里仍然存在的技能 scope。 */
export function pruneSkills(selected: string[], skills: CustomAgentCatalog['skills']): string[] {
  const scopes = new Set(skills.map(skill => skill.scope));
  return selected.filter(scope => scopes.has(scope));
}

/** 工具目录按名称排序后按只读/写入分组，布局而不是文字标签区分权限。 */
export function groupCatalogTools(tools: CustomAgentCatalogTool[]): { readOnly: CustomAgentCatalogTool[]; write: CustomAgentCatalogTool[] } {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  return { readOnly: sorted.filter(tool => tool.readOnly), write: sorted.filter(tool => !tool.readOnly) };
}

export const catalogToolsFor = (catalog: CustomAgentCatalog | undefined, projectHash: string) =>
  projectHash ? catalog?.projectTools ?? [] : catalog?.chatTools ?? [];
