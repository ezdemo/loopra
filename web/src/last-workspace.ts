/** The project last chosen in this browser. Hashes are path-based, so a desktop port change still matches. */
export const LAST_WORKSPACE_KEY = 'loopra:last-workspace';

type WorkspaceRef = { hash: string; path?: string };

export function readLastWorkspace(storage: Pick<Storage, 'getItem'>): string {
  try {
    const saved = JSON.parse(storage.getItem(LAST_WORKSPACE_KEY) || 'null');
    return typeof saved === 'string' ? saved : '';
  } catch {
    return '';
  }
}

export function writeLastWorkspace(storage: Pick<Storage, 'setItem'>, hash: string) {
  if (!hash) return;
  try { storage.setItem(LAST_WORKSPACE_KEY, JSON.stringify(hash)); } catch { /* Storage can be blocked; the in-memory choice still works. */ }
}

/** Keep the live choice. Otherwise restore the last one, then the configured project, then the first entry. */
export function preferredWorkspace(current: string, workspaces: WorkspaceRef[], remembered: string, configuredPath?: string): string {
  if (!workspaces.length) return current;
  if (workspaces.some(item => item.hash === current)) return current;
  if (remembered && workspaces.some(item => item.hash === remembered)) return remembered;
  return workspaces.find(item => !!item.path && item.path === configuredPath)?.hash || workspaces[0]?.hash || '';
}
