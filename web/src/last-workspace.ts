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

/** What the page knows about the service record of the last opened project. */
export type LastWorkspaceSync = {
  /** The service answered and named a project, or answered that it has none. */
  answered: boolean;
  /** The read failed, so the record is unknown and must not be overwritten. */
  unread: boolean;
  /** The record the service reported, empty when it has none. */
  stored: string;
  /** The project the page is showing right now. */
  current: string;
  /** The last value this page wrote, so an unchanged project is not reported again. */
  reported: string;
  /** The user picked a project here, which outranks a record that arrives later. */
  picked: boolean;
  /** Whether a hash still names a project that exists. */
  exists: (hash: string) => boolean;
};

/**
 * Both effects below ask the same questions - is the record known, is it still valid,
 * and is it worth writing back - so the answers live here instead of in the component.
 * A null project means 'settle and restore', while the empty string is a real answer
 * from the service: it has no record, so the configured project may stand.
 */
export function settledLastWorkspace(state: Pick<LastWorkspaceSync, 'answered' | 'stored' | 'exists'>): string | null {
  if (!state.answered) return null;
  return state.exists(state.stored) ? state.stored : '';
}

export function shouldRestoreWorkspace(state: Pick<LastWorkspaceSync, 'answered' | 'stored' | 'picked' | 'current' | 'exists'>): boolean {
  const settled = settledLastWorkspace(state);
  // A pick already made here wins, and re-selecting the visible project would only
  // reset the scroll position and reload the sessions below it.
  return !!settled && !state.picked && state.current !== settled;
}

/**
 * Reporting is what makes the record follow the user to another browser, so it has to
 * be both useful and safe: never before the service answered, never after a failed read,
 * never for a project that is not on screen, and never twice for the same one.
 */
export function shouldRecordWorkspace(state: LastWorkspaceSync): boolean {
  if (!state.answered || state.unread) return false;
  if (!state.current || !state.exists(state.current)) return false;
  if (state.current === state.reported) return false;
  // A restored project is not a switch: the service already knows it, and writing it
  // back would let one browser's startup undo a record another browser just made.
  const settled = settledLastWorkspace(state) || '';
  return state.picked || state.current !== settled;
}
