import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
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
      notify(checked ? t('isolation.enabled') : t('isolation.local'));
    } catch (cause) {
      notify(t(checked ? 'isolation.enableFailed' : 'isolation.disableFailed', { error: cause instanceof Error ? cause.message : String(cause) }));
      void load();
    } finally { setBusy(false); }
  }

  const on = !!mode?.worktreeMode;
  const title = !sessionName ? t('isolation.preparing')
    : !mode ? t('isolation.loading')
    : busy ? t('isolation.switching')
    : on ? t('isolation.onTitle')
    : t('isolation.offTitle');
  return <button type="button" role="switch" aria-checked={on} aria-label={t('nav.worktreeMode')}
    className={`isolation-switch${on ? ' is-on' : ''}`} title={title}
    disabled={!sessionName || !mode || busy || !!disabled} onClick={() => void toggle(!on)}>
    <span className="isolation-track" aria-hidden="true"><span className="isolation-knob" /></span>
    <span className="isolation-text">{busy ? t('isolation.switchingShort') : t('isolation.switch')}</span>
  </button>;
}
