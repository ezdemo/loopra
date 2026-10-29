// Legacy FileExplorer.vue / FileExplorerNode.vue tinted the file tree with git
// status letters (M/A/D/U) and a small colored dot on ancestor directories. The
// web file panel lost that decoration, so this module rebuilds the map from the
// same GET /git/status payload the Git tab uses.

export type DecorationKind = 'untracked' | 'added' | 'deleted' | 'modified';
export type GitDecoration = { label: string; kind: DecorationKind };
export type GitStatusFile = { path?: string; status?: string };
export type GitStatus = { initialized?: boolean; changed?: GitStatusFile[]; untracked?: GitStatusFile[] };

// Mirrors legacy decorationFor(): U/? → untracked, A → added, D → deleted, else modified.
export function decorationFor(status: string | undefined): GitDecoration {
  const label = String(status || 'M').toUpperCase();
  if (label === 'U' || label === '?') return { label: 'U', kind: 'untracked' };
  if (label === 'A') return { label, kind: 'added' };
  if (label === 'D') return { label, kind: 'deleted' };
  return { label, kind: 'modified' };
}

export function relativeGitPath(path: string | undefined): string {
  return String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

// Keyed by workspace-relative paths with forward slashes — the same shape the
// file tree and search results use. Every ancestor directory inherits the
// changed file's kind with an empty label, so a folder holding a modified file
// tints amber exactly like the legacy directory dot.
export function buildDecorations(status: GitStatus | undefined | null): Record<string, GitDecoration> {
  const map: Record<string, GitDecoration> = {};
  if (!status?.initialized) return map;
  for (const file of [...(status.changed || []), ...(status.untracked || [])]) {
    const relative = relativeGitPath(file.path);
    if (!relative) continue;
    const decoration = decorationFor(file.status);
    map[relative] = decoration;
    for (let slash = relative.lastIndexOf('/'); slash > 0; slash = relative.lastIndexOf('/', slash - 1)) {
      const directory = relative.slice(0, slash);
      if (!map[directory]) map[directory] = { label: '', kind: decoration.kind };
    }
  }
  return map;
}
