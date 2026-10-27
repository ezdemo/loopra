import type { LoopraClient, Workspace } from '../backend';
import type { Session } from '../lib';
import SchedulePanel from './SchedulePanel';

export default function SchedulesPage({ api, workspaces, sessions, onOpenSession }: {
  api: LoopraClient; workspaces: Workspace[]; sessions: Session[]; onBack: () => void; onOpenSession: (workspaceHash: string, sessionName: string) => void;
}) {
  return <section className="skills-hub schedules-hub" aria-label="定时任务"><div className="skills-hub-inner"><SchedulePanel api={api} workspaces={workspaces} sessions={sessions} onOpenSession={onOpenSession} /></div></section>;
}
