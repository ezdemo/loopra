import { useEffect, type Dispatch, type SetStateAction } from 'react';
import type { LoopraClient } from './backend';
import type { Session } from './lib';
import { subSessionLabel, subSessionsPath, type SubSession } from './sub-sessions';
import { emptyWorkspaceTabs, ensureSubAgentTab, type WorkspaceTabs } from './workspace-tabs';

/** Recover tabs after reload, session switches, and a turn that rebuilt ACP history. */
export function useSubAgentTabs(api: Pick<LoopraClient, 'request'>, server: string, session: Session | undefined,
  connected: boolean, runId: string | null, setTabs: Dispatch<SetStateAction<Record<string, WorkspaceTabs>>>) {
  useEffect(() => {
    if (!session?.name || !session.workspaceHash || !connected) return;
    const target = session;
    const key = `${server}/${target.workspaceHash}`;
    const controller = new AbortController();
    void api.request<SubSession[]>(subSessionsPath(target.workspaceHash!, target.name!), 'GET', undefined, controller.signal)
      .then(runs => {
        if (controller.signal.aborted) return;
        setTabs(current => ({ ...current, [key]: runs.reduce((tabs, run) => ensureSubAgentTab(tabs,
          { subSessionId: run.subSessionId, sessionName: target.name!, label: subSessionLabel(run) }), current[key] || emptyWorkspaceTabs) }));
      }).catch(() => {});
    return () => controller.abort();
  }, [api, server, session?.id, connected, runId, setTabs]);
}
