// Session-management view model ported from legacy `src/views/Sessions.vue`.
// The legacy page derived its four summary cards plus client-side paging from
// the raw session list; keep those formulas identical so the numbers match.

export type ManagedSession = {
  id: string; title: string; workspace?: string; workspaceHash?: string; name?: string;
  messageCount?: number; mtime?: number; worktreeMode?: boolean;
};

export type SessionMetrics = { sessionCount: number; totalMessages: number; totalToolCalls: number; averageSessionLength: string };

export function sessionMetrics(sessions: ManagedSession[]): SessionMetrics {
  const totalMessages = sessions.reduce((sum, session) => sum + (session.messageCount || 0), 0);
  const hours = Math.floor(totalMessages / 10);
  const minutes = (totalMessages % 10) * 6;
  return {
    sessionCount: sessions.length,
    totalMessages,
    totalToolCalls: Math.floor(totalMessages * 0.6),
    averageSessionLength: `${hours}h ${minutes}m`,
  };
}

export function formatTokenUsage(tokens: number) {
  if (!tokens || tokens <= 0) return '0';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return String(tokens);
}

/** Case-insensitive match over title, session name and workspace label. */
export function filterSessions<T extends ManagedSession>(sessions: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return sessions;
  return sessions.filter(session => [session.title, session.name, session.workspace, session.id]
    .some(value => (value || '').toLowerCase().includes(needle)));
}

export function paginate<T>(items: T[], page: number, pageSize: number) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  return { page: current, totalPages, items: items.slice((current - 1) * pageSize, current * pageSize) };
}

export function formatSessionTime(mtime?: number) {
  if (!mtime) return '—';
  const date = new Date(mtime);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Legacy exportSession(): the card's row is downloaded as JSON. */
export function sessionExportPayload(session: ManagedSession) {
  return JSON.stringify({ ...session, exportedAt: new Date().toISOString() }, null, 2);
}
