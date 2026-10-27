/** `environment` is the session name for files read from an isolated worktree. */
export type WorkspaceFile = { path: string; mode: 'content' | 'diff'; diff?: string; environment?: string };
/** A sub-agent run opened as a tab next to the conversation and files. */
export type WorkspaceSubAgentTab = { subSessionId: string; sessionName: string; label: string };
export type WorkspaceTabs = { files: WorkspaceFile[]; agents: WorkspaceSubAgentTab[]; active: string | null };
export const emptyWorkspaceTabs: WorkspaceTabs = { files: [], agents: [], active: null };

/** Sub-agent tabs share `active` with file paths, so their key is namespaced. */
export const subAgentTabKey = (subSessionId: string) => `subagent:${subSessionId}`;

export function openWorkspaceFile(state: WorkspaceTabs, file: WorkspaceFile): WorkspaceTabs {
  const path = file.path.replaceAll('\\', '/').replace(/^\.\//, '');
  const existing = state.files.find(item => item.path === path);
  // File tree, Git and historical change links all open the same live preview.
  const next: WorkspaceFile = { path, mode: 'content', ...(file.environment ? { environment: file.environment } : {}) };
  return { ...state, files: existing ? state.files.map(item => item.path === path ? next : item) : [...state.files, next], active: path };
}

export function closeWorkspaceFile(state: WorkspaceTabs, path: string): WorkspaceTabs {
  const index = state.files.findIndex(file => file.path === path);
  const files = state.files.filter(file => file.path !== path);
  return { ...state, files, active: state.active === path ? files[Math.max(0, index - 1)]?.path ?? null : state.active };
}

/** Open (or refresh) a sub-agent tab and show it. */
export function openSubAgentTab(state: WorkspaceTabs, tab: WorkspaceSubAgentTab): WorkspaceTabs {
  const existing = state.agents.some(item => item.subSessionId === tab.subSessionId);
  return { ...state, agents: existing ? state.agents.map(item => item.subSessionId === tab.subSessionId ? tab : item) : [...state.agents, tab], active: subAgentTabKey(tab.subSessionId) };
}

/**
 * Add a tab for a run that started in the background without stealing focus from
 * the conversation/file the user is watching. An already known run is left as is.
 */
export function ensureSubAgentTab(state: WorkspaceTabs, tab: WorkspaceSubAgentTab): WorkspaceTabs {
  const existing = state.agents.find(item => item.subSessionId === tab.subSessionId);
  if (!existing) return { ...state, agents: [...state.agents, tab] };
  if (existing.label === tab.label && existing.sessionName === tab.sessionName) return state;
  return { ...state, agents: state.agents.map(item => item.subSessionId === tab.subSessionId ? tab : item) };
}

export function closeSubAgentTab(state: WorkspaceTabs, subSessionId: string): WorkspaceTabs {
  const key = subAgentTabKey(subSessionId);
  const index = state.agents.findIndex(item => item.subSessionId === subSessionId);
  const agents = state.agents.filter(item => item.subSessionId !== subSessionId);
  if (state.active !== key) return { ...state, agents };
  const neighbour = agents[Math.max(0, index - 1)];
  return { ...state, agents, active: neighbour ? subAgentTabKey(neighbour.subSessionId) : null };
}

export function updateWorkspaceFilePath(state: WorkspaceTabs, from: string, to?: string): WorkspaceTabs {
  const inside = (path: string) => path === from || path.startsWith(`${from}/`);
  if (to === undefined) return state.files.filter(file => inside(file.path)).reduce((current, file) => closeWorkspaceFile(current, file.path), state);
  const swap = (path: string) => inside(path) ? `${to}${path.slice(from.length)}` : path;
  return { ...state, files: state.files.map(file => ({ ...file, path: swap(file.path) })), active: state.active === null ? null : swap(state.active) };
}
