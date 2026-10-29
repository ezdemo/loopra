import type { Session } from './lib';
import type { LiveSpeed } from './composer';

export type SessionRun = {
  key: string; originKey: string; server: string; requestId: string; controller: AbortController;
  workspaceHash?: string; session?: Session; stopping?: boolean; stopPromise?: Promise<void>;
};
export type RunView = { server: string; activeId: string | null; draftKey?: string };
export const sessionRunKey = (server: string, id: string) => JSON.stringify([server, 'session', id]);
export const draftRunKey = (server: string, workspace: string, agent: string, revision: number) => JSON.stringify([server, 'draft', workspace, agent, revision]);
export function isRunView(run: SessionRun, view: RunView): boolean {
  return run.server === view.server && (view.activeId ? run.session?.id === view.activeId : run.originKey === view.draftKey);
}

/** Own each stream independently. Identity checks prevent a late completion removing a replacement. */
export class SessionRuns {
  // Leave room for approvals, cancellation and history requests beside long-lived streams.
  constructor(readonly limit = 4) { if (!Number.isInteger(limit) || limit < 1) throw new Error('并行会话上限必须是正整数'); }
  private active = new Map<string, SessionRun>();
  private speeds = new Map<string, LiveSpeed>();
  private unread = new Set<string>();
  private listeners = new Set<() => void>();
  private revision = 0;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.revision;
  private emit() { this.revision++; this.listeners.forEach(listener => listener()); }
  get(key: string) { return this.active.get(key) || [...this.active.values()].find(run => run.originKey === key); }
  count(server: string) { return [...this.active.values()].filter(run => run.server === server).length; }
  hasActive(server: string) { return this.count(server) > 0; }
  runningIds(server: string) { return new Set([...this.active.values()].filter(run => run.server === server && run.session).map(run => run.session!.id)); }
  unreadIds(server: string, sessions: Session[]) { return new Set(sessions.filter(session => this.unread.has(sessionRunKey(server, session.id))).map(session => session.id)); }
  owns(run: SessionRun) { return this.active.get(run.key) === run; }
  claim(key: string, input: Omit<SessionRun, 'key' | 'originKey'>): SessionRun | undefined {
    if (this.get(key) || this.count(input.server) >= this.limit) return;
    const run = { ...input, key, originKey: key };
    this.active.set(key, run); this.speeds.delete(key); this.unread.delete(key); this.emit();
    return run;
  }
  bind(run: SessionRun, session: Session): boolean {
    if (!this.owns(run)) return false;
    const key = sessionRunKey(run.server, session.id);
    if (this.active.has(key) && this.active.get(key) !== run) return false;
    this.active.delete(run.key); run.key = key; run.session = session;
    this.active.set(key, run); this.speeds.delete(key); this.unread.delete(key); this.emit();
    return true;
  }
  speed(key: string) { return this.speeds.get(key); }
  setSpeed(run: SessionRun, speed: LiveSpeed) {
    if (!this.owns(run)) return;
    this.speeds.set(run.key, speed); this.emit();
  }
  markRead(server: string, id: string) { if (this.unread.delete(sessionRunKey(server, id))) this.emit(); }
  finish(run: SessionRun, unread = false): boolean {
    if (!this.owns(run)) return false;
    this.active.delete(run.key);
    const speed = this.speeds.get(run.key);
    if (speed) this.speeds.set(run.key, { ...speed, done: true, avgTokensPerSecond: speed.avgTokensPerSecond ?? speed.tokensPerSecond });
    if (unread && run.session) this.unread.add(run.key);
    this.emit(); return true;
  }
  detach(server?: string) {
    for (const run of [...this.active.values()]) {
      if (server !== undefined && run.server !== server) continue;
      this.active.delete(run.key); run.controller.abort();
    }
    this.emit();
  }
}
