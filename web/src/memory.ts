export type MemoryEntry = {
  id: string;
  title: string;
  content: string;
  kind: 'fact' | 'preference' | 'environment';
  source: 'user' | 'agent';
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export function memoryPath(scope: 'global' | 'project', workspaceHash: string, id?: string, revision?: number) {
  const query = new URLSearchParams({ scope });
  if (scope === 'project') query.set('workspaceHash', workspaceHash);
  if (revision !== undefined) query.set('revision', String(revision));
  return `/memories${id ? `/${encodeURIComponent(id)}` : ''}?${query}`;
}
