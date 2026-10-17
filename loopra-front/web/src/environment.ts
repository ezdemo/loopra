// Session-environment helpers and the pure listing rules used by the Git tab.
// All Git operations (status, history, commit, push) run in the Java backend,
// which resolves the main/worktree paths from workspaceHash + sessionName.

export type EnvironmentMode = 'local' | 'worktree' | 'unavailable';

export type EnvironmentSummary = {
  workspaceHash: string;
  sessionName: string;
  mode: EnvironmentMode;
  mainPath: string | null;
  mainBranch: string | null;
  mainDirty: boolean;
  currentPath: string | null;
  currentBranch: string | null;
  currentDirty: boolean;
  worktreeExists: boolean;
  agentRunning: boolean;
  message: string | null;
};

export type GitFileEntry = { path: string; index: string; workTree: string; status: string };

export type GitStatus = {
  gitAvailable?: boolean;
  initialized: boolean;
  branch: string;
  workspacePath?: string;
  dirty: boolean;
  changed: GitFileEntry[];
  untracked: GitFileEntry[];
  ahead?: number;
  behind?: number;
  upstream?: string;
  message?: string;
};

/** GET /git/environment/status — both checkouts resolved and read by the backend. */
export type EnvironmentGitStatus = {
  workspaceHash: string;
  sessionName: string;
  mode: EnvironmentMode;
  mainPath: string | null;
  mainBranch: string | null;
  currentPath: string | null;
  currentBranch: string | null;
  main: GitStatus | null;
  current: GitStatus | null;
};

export type GitCommitEntry = { hash: string; shortHash: string; author: string; date: string; subject: string };

export type MergeMode = 'manual' | 'ai-auto' | 'ai-auto-approve';

export type SessionWorktreeMode = { workspaceHash?: string; sessionName?: string; worktreeMode: boolean; mergeMode: MergeMode };

/** Electron returns changed (tracked) entries first, then untracked ones; the panel shows one list. */
export function environmentEntries(status?: GitStatus | null): GitFileEntry[] {
  return [...(status?.changed ?? []), ...(status?.untracked ?? [])];
}

/** The backend status payload carries the file lists; the panel derives the dirty flag from them. */
export function normalizeEnvironmentStatus(status?: GitStatus | null): GitStatus | null {
  return status ? { ...status, dirty: environmentEntries(status).length > 0 } : null;
}

export type EntryTone = 'added' | 'modified' | 'deleted' | 'untracked';

export function environmentEntryTone(entry: GitFileEntry): EntryTone {
  if (entry.index === '?' && entry.workTree === '?') return 'untracked';
  if (entry.index === 'D' || entry.workTree === 'D') return 'deleted';
  if (entry.index === 'A' || entry.index === '?') return 'added';
  return 'modified';
}

/** Short porcelain label: staged / deleted / untracked / modified. */
export function environmentEntryLabel(entry: GitFileEntry) {
  if (entry.index === '?' && entry.workTree === '?') return '新';
  if (entry.index !== ' ') return '暂';
  if (entry.workTree === 'D') return '删';
  return '改';
}

export const MERGE_MODES: { value: MergeMode; label: string }[] = [
  { value: 'manual', label: '手动' },
  { value: 'ai-auto', label: 'AI 自动' },
  { value: 'ai-auto-approve', label: 'AI 自动并审批' },
];

export function formatCommitDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || '';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}

/** Ahead/behind summary for the current branch; empty when there is no upstream. */
export function trackingSummary(status?: GitStatus | null) {
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  if (!ahead && !behind) return '';
  return [ahead ? `领先 ${ahead}` : '', behind ? `落后 ${behind}` : ''].filter(Boolean).join(' · ');
}
