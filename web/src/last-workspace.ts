/** The project last chosen on this service. Stored on the service and mirrored per browser. */
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

/**
 * The service record wins: it follows the user across browsers and devices.
 * The browser cache only covers the window before the service answer arrives,
 * and an older service that has no record yet.
 *
 * Both may name a project that has since been deleted. A stale service record
 * must not keep the page from falling back to the configured project, so each
 * one is accepted only when it still exists.
 */
export function lastWorkspaceChoice(remembered: string, stored: string, exists: (hash: string) => boolean = () => true): string {
  return [stored, remembered].find(hash => !!hash && exists(hash)) || '';
}

/** Keep the live choice. Otherwise restore the last one, then the configured project, then the first entry. */
export function preferredWorkspace(current: string, workspaces: WorkspaceRef[], remembered: string, configuredPath?: string): string {
  if (!workspaces.length) return current;
  if (workspaces.some(item => item.hash === current)) return current;
  if (remembered && workspaces.some(item => item.hash === remembered)) return remembered;
  return workspaces.find(item => !!item.path && item.path === configuredPath)?.hash || workspaces[0]?.hash || '';
}

type WorkspaceRecord =
  | { status: 'loading' }
  | { status: 'received'; hash: string }
  | { status: 'ready'; hash: string }
  | { status: 'failed' };

export type WorkspaceSelection = {
  server: string;
  current: string;
  picked: boolean;
  record: WorkspaceRecord;
};

type WorkspaceAction =
  | { type: 'reset'; server: string; cached: string }
  | { type: 'select'; server: string; hash: string }
  | { type: 'received'; server: string; hash: string }
  | { type: 'failed'; server: string }
  | { type: 'reconcile'; server: string; workspaces: WorkspaceRef[]; cached: string; configuredPath?: string };

export function initialWorkspaceSelection(server: string, cached: string): WorkspaceSelection {
  return { server, current: cached, picked: false, record: { status: 'loading' } };
}

/** Restore once the project list is known. Every explicit selection wins over a late read. */
export function workspaceSelectionReducer(state: WorkspaceSelection, action: WorkspaceAction): WorkspaceSelection {
  if (action.type === 'reset') {
    return state.server === action.server ? state : initialWorkspaceSelection(action.server, action.cached);
  }
  if (action.server !== state.server) return state;
  switch (action.type) {
    case 'select':
      return { ...state, current: action.hash, picked: true };
    case 'received':
      return { ...state, record: { status: 'received', hash: action.hash } };
    case 'failed':
      return { ...state, record: { status: 'failed' } };
    case 'reconcile': {
      if (!action.workspaces.length) return state;
      const exists = (hash: string) => action.workspaces.some(item => item.hash === hash);
      let { current, record } = state;
      if (record.status === 'received') {
        const hash = exists(record.hash) ? record.hash : '';
        record = { status: 'ready', hash };
        if (hash && !state.picked) current = hash;
      }
      const stored = record.status === 'ready' ? record.hash : '';
      current = preferredWorkspace(current, action.workspaces, lastWorkspaceChoice(action.cached, stored, exists), action.configuredPath);
      return current === state.current && record === state.record ? state : { ...state, current, record };
    }
  }
}
