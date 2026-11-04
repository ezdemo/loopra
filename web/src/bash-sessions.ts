// Background command sessions, ported from legacy `components/BashSessionManager.vue`:
// the chat tool's `bash_start` runs live on as a session the UI can inspect.
export type BashSession = { sessionId: string; owner?: string; workspaceHash?: string; workspace?: string; command: string; workdir?: string; startedAt?: number; status: string };

/** Every call is scoped to the owning session: the backend registry is
 *  process-wide, so the session name is what keeps one conversation's
 *  background commands out of another conversation's (or project's) panel. */
const sessionParams = (workspaceHash: string, sessionName?: string) =>
  ({ workspaceHash, ...(sessionName ? { sessionName } : {}) });
export const bashSessionsPath = (workspaceHash: string, sessionName?: string) =>
  `/agent/bash-sessions?${new URLSearchParams(sessionParams(workspaceHash, sessionName))}`;
export const bashSessionLogPath = (workspaceHash: string, sessionName: string | undefined, sessionId: string) =>
  `/agent/bash-sessions/log?${new URLSearchParams({ ...sessionParams(workspaceHash, sessionName), sessionId })}`;

export const runningCount = (sessions: BashSession[]) => sessions.filter(session => session.status === 'running').length;

export const bashSessionSummary = (sessions: BashSession[]) =>
  sessions.length ? `${runningCount(sessions)} 个运行中 · 共 ${sessions.length} 个进程` : '暂无后台进程';

export const bashSessionState = (session: BashSession) => session.status === 'running' ? '运行中' : '已结束';

/** Legacy collapses long durations to a single unit: 秒 / 分钟 / 小时 / 天. */
export function formatBashDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0 秒';
  if (seconds < 60) return `${Math.floor(seconds)} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时`;
  return `${Math.floor(seconds / 86400)} 天`;
}

export function formatBashUptime(session: BashSession, now = Date.now()) {
  if (session.status !== 'running') return '已结束';
  const seconds = (now - Number(session.startedAt)) / 1000;
  return Number.isFinite(seconds) ? `已运行 ${formatBashDuration(seconds)}` : '启动时间未知';
}

export function workspaceName(path?: string) {
  if (!path) return '';
  const parts = String(path).replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.at(-1) || String(path);
}
