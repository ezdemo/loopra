import { useCallback, useEffect, useRef, useState } from 'react';
import type { LoopraClient } from '../backend';
import type { SessionWorktreeMode } from '../environment';
import { notifyWorkspaceChanged, watchWorkspaceChanges } from '../workspace-events';

type Props = {
  api: LoopraClient;
  workspaceHash: string;
  /** The prepared draft session; the switch stays disabled until it exists. */
  sessionName?: string;
  disabled?: boolean;
  notify: (message: string) => void;
};

/**
 * Isolation switch for a new conversation, shown beside the project and Agent
 * switchers. It writes the same session flag the Git tab uses, so both views
 * agree through workspace-change notifications.
 */
export default function IsolationSwitch({ api, workspaceHash, sessionName, disabled, notify }: Props) {
  const [mode, setMode] = useState<SessionWorktreeMode>();
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  const url = sessionName
    ? `/sessions/${encodeURIComponent(sessionName)}/worktree?workspaceHash=${encodeURIComponent(workspaceHash)}`
    : '';

  const load = useCallback(async () => {
    if (!url) { setMode(undefined); return; }
    const current = ++sequence.current;
    try {
      const next = await api.request<SessionWorktreeMode>(url, 'GET');
      if (current === sequence.current) setMode(next);
    } catch {
      if (current === sequence.current) setMode(undefined);
    }
  }, [api, url]);

  useEffect(() => { setMode(undefined); void load(); }, [load]);
  // The Git tab's isolation toggle changes the same flag.
  useEffect(() => watchWorkspaceChanges(workspaceHash, () => void load()), [workspaceHash, load]);

  async function toggle(checked: boolean) {
    if (!sessionName || !mode || busy || disabled) return;
    setBusy(true);
    try {
      const next = await api.request<SessionWorktreeMode>(url, 'PUT', { ...mode, worktreeMode: checked });
      setMode(next);
      if (checked) {
        try { await api.request('/git/worktree/create', 'POST', { workspaceHash, sessionName }); }
        catch (cause) {
          // Never leave the session pointed at a worktree that does not exist.
          await api.request<SessionWorktreeMode>(url, 'PUT', { ...mode, worktreeMode: false }).then(setMode).catch(() => undefined);
          throw cause;
        }
      }
      notifyWorkspaceChanged(workspaceHash);
      notify(checked ? '已启用隔离分支' : '已切换到本地修改');
    } catch (cause) {
      notify(`${checked ? '启用' : '关闭'}隔离分支失败：${cause instanceof Error ? cause.message : String(cause)}`);
      void load();
    } finally { setBusy(false); }
  }

  const on = !!mode?.worktreeMode;
  const title = !sessionName ? '正在准备会话…'
    : !mode ? '正在读取隔离分支状态…'
    : busy ? '正在切换隔离分支…'
    : on ? '隔离分支：Agent 在独立 worktree 中读写文件'
    : '本地修改：Agent 直接读写当前项目';
  return <button type="button" role="switch" aria-checked={on} aria-label="隔离分支模式"
    className={`isolation-switch${on ? ' is-on' : ''}`} title={title}
    disabled={!sessionName || !mode || busy || !!disabled} onClick={() => void toggle(!on)}>
    <span className="isolation-track" aria-hidden="true"><span className="isolation-knob" /></span>
    <span className="isolation-text">{busy ? '切换中…' : '隔离分支'}</span>
  </button>;
}
