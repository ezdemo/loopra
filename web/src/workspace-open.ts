/** Open the selected project once, when the page first knows which one it is. */
export function initialOpenWorkspace(expanded: readonly string[], workspace: string, workspaces: readonly { hash: string }[], applied: boolean): { expanded: string[]; applied: boolean } {
  if (applied || !workspace || !workspaces.some(item => item.hash === workspace)) return { expanded: [...expanded], applied };
  return { expanded: expanded.includes(workspace) ? [...expanded] : [...expanded, workspace], applied: true };
}
