const WORKSPACE_CHANGED = 'loopra:workspace-changed';

export function notifyWorkspaceChanged(workspaceHash: string | undefined) {
  if (workspaceHash) window.dispatchEvent(new CustomEvent(WORKSPACE_CHANGED, { detail: { workspaceHash } }));
}

export function watchWorkspaceChanges(workspaceHash: string, refresh: () => void) {
  const listener = (event: Event) => {
    if ((event as CustomEvent<{ workspaceHash?: string }>).detail?.workspaceHash === workspaceHash) refresh();
  };
  window.addEventListener(WORKSPACE_CHANGED, listener);
  return () => window.removeEventListener(WORKSPACE_CHANGED, listener);
}
