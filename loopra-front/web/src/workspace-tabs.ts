export type WorkspaceFile = { path: string; mode: 'content' | 'diff'; diff?: string };
export type WorkspaceTabs = { files: WorkspaceFile[]; active: string | null };
export const emptyWorkspaceTabs: WorkspaceTabs = { files: [], active: null };

export function openWorkspaceFile(state: WorkspaceTabs, file: WorkspaceFile): WorkspaceTabs {
  const path = file.path.replaceAll('\\', '/').replace(/^\.\//, '');
  const existing = state.files.find(item => item.path === path);
  const next = { ...file, path };
  return { files: existing ? state.files.map(item => item.path === path ? next : item) : [...state.files, next], active: path };
}

export function closeWorkspaceFile(state: WorkspaceTabs, path: string): WorkspaceTabs {
  const index = state.files.findIndex(file => file.path === path);
  const files = state.files.filter(file => file.path !== path);
  return { files, active: state.active === path ? files[Math.max(0, index - 1)]?.path ?? null : state.active };
}

export function updateWorkspaceFilePath(state: WorkspaceTabs, from: string, to?: string): WorkspaceTabs {
  const inside = (path: string) => path === from || path.startsWith(`${from}/`);
  if (to === undefined) return state.files.filter(file => inside(file.path)).reduce((current, file) => closeWorkspaceFile(current, file.path), state);
  const swap = (path: string) => inside(path) ? `${to}${path.slice(from.length)}` : path;
  return { files: state.files.map(file => ({ ...file, path: swap(file.path) })), active: state.active === null ? null : swap(state.active) };
}
