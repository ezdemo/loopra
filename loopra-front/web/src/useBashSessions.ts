import { useEffect, useRef, useState } from 'react';
import type { LoopraClient } from './backend';
import { bashSessionLogPath, bashSessionsPath, type BashSession } from './bash-sessions';

/** One live cache for the task entry, task list and selected task's output. */
export function useBashSessions(api: LoopraClient, workspaceHash: string, enabled = true) {
  const [sessions, setSessions] = useState<BashSession[]>([]);
  const [selected, setSelected] = useState('');
  const selectedRef = useRef('');
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [terminating, setTerminating] = useState<string[]>([]);
  const refresh = () => setRevision(value => value + 1);
  useEffect(() => {
    if (!enabled || !workspaceHash) { setLoading(false); return; }
    const controller = new AbortController();
    let pending = false;
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const list = await api.request<BashSession[]>(bashSessionsPath(workspaceHash), 'GET', undefined, controller.signal);
        if (controller.signal.aborted) return;
        setSessions(list);
        const id = list.some(item => item.sessionId === selectedRef.current) ? selectedRef.current : list[0]?.sessionId || '';
        selectedRef.current = id; setSelected(id);
        if (id) {
          const log = await api.request<{ output: string }>(bashSessionLogPath(workspaceHash, id), 'GET', undefined, controller.signal);
          if (controller.signal.aborted) return;
          setLogs(current => ({ ...current, [id]: log.output }));
        }
        setError('');
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '读取失败');
      } finally {
        pending = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [api, workspaceHash, enabled, revision]);
  useEffect(() => {
    if (!enabled) return;
    window.addEventListener('loopra:bash-start', refresh);
    return () => window.removeEventListener('loopra:bash-start', refresh);
  }, [enabled]);
  function select(id: string) {
    if (selectedRef.current === id) return;
    selectedRef.current = id; setSelected(id); setLoading(true); refresh();
  }
  async function terminate(id = selectedRef.current) {
    if (!id || terminating.includes(id)) return;
    setTerminating(current => [...current, id]);
    try {
      await api.request('/agent/bash-sessions/terminate', 'POST', { sessionId: id, workspaceHash });
      refresh();
    } finally { setTerminating(current => current.filter(value => value !== id)); }
  }
  return { sessions, selected, output: logs[selected], loading, error, refresh, select, terminate, terminating };
}

export type BashSessionsState = ReturnType<typeof useBashSessions>;
