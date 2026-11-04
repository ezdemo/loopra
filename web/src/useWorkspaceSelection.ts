import { useCallback, useEffect, useMemo, useReducer } from 'react';
import type { LoopraClient, Workspace } from './backend';
import { initialWorkspaceSelection, readLastWorkspace, workspaceSelectionReducer, writeLastWorkspace } from './last-workspace';

/** Owns project selection, startup restoration and ordered persistence for one service. */
export function useWorkspaceSelection(server: string, api: LoopraClient, workspaces: Workspace[], configuredPath?: string) {
  const [state, dispatch] = useReducer(workspaceSelectionReducer, undefined,
    () => initialWorkspaceSelection(server, readLastWorkspace(localStorage)));
  const saves = useMemo(() => ({
    queue: Promise.resolve(), saved: null as string | null, requested: null as string | null,
  }), [api]);
  const workspace = state.server === server ? state.current : '';

  useEffect(() => {
    dispatch({ type: 'reset', server, cached: readLastWorkspace(localStorage) });
  }, [server]);
  useEffect(() => {
    dispatch({ type: 'reconcile', server, workspaces, configuredPath, cached: readLastWorkspace(localStorage) });
  }, [server, workspaces, configuredPath, state.current, state.record]);
  useEffect(() => {
    if (!workspace || !workspaces.some(item => item.hash === workspace)) return;
    writeLastWorkspace(localStorage, workspace);
    if (state.server !== server || state.record.status !== 'ready') return;
    saves.saved ??= state.record.hash;
    if (workspace === (saves.requested ?? saves.saved)) return;
    saves.requested = workspace;
    // Keep the newest selection last even when earlier requests are slow.
    saves.queue = saves.queue.then(async () => {
      if (saves.requested !== workspace) return;
      await api.request('/ui-preferences', 'PUT', { lastWorkspace: workspace });
      saves.saved = workspace;
    }).catch(error => {
      if (saves.requested === workspace) saves.requested = saves.saved;
      console.warn('[workspace] Failed to save the selected project:', error);
    });
  }, [api, server, workspace, workspaces, state, saves]);

  const select = useCallback((hash: string) => dispatch({ type: 'select', server, hash }), [server]);
  const receive = useCallback((hash: string) => dispatch({ type: 'received', server, hash }), [server]);
  const fail = useCallback(() => dispatch({ type: 'failed', server }), [server]);
  return { workspace, select, receive, fail };
}
