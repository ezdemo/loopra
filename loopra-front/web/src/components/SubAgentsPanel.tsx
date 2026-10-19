import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@nextui-org/react';
import { ChevronRight, ExternalLink, RefreshCw, Trash2 } from 'lucide-react';
import type { LoopraClient } from '../backend';
import { ConfirmAction, RemoteState, errorText, useRemote } from './RemoteControls';
import { IconButton } from './ui';
import BlockRenderer from './BlockRenderer';
import { continueSubSession, formatSubTime, subSessionBlocks, subSessionEventsPath, subSessionsPath, subSessionLabel, subStatusLabel, type SubSession, type SubSessionEvent } from '../sub-sessions';

// Ported from legacy `src/components/SubAgentPanel.vue` plus the desktop chat
// tab's replay view: list the current session's sub-agent runs, replay their
// stored events as blocks, delete a finished run, and continue an active one.
export default function SubAgentsPanel({ api, workspaceHash, sessionName, notify, onDiff, onOpenTab }: {
  api: LoopraClient; workspaceHash: string; sessionName?: string; notify: (message: string) => void; onDiff?: (path: string) => void;
  onOpenTab?: (item: SubSession) => void;
}) {
  // Two revisions on purpose: polling only refreshes the list (event counts),
  // while the event revision re-reads the stored replay. Bumping the list alone
  // keeps streamed blocks from a `continue` call on screen.
  const [listRevision, setListRevision] = useState(0);
  const [eventRevision, setEventRevision] = useState(0);
  const [selected, setSelected] = useState<SubSession>();
  const [events, setEvents] = useState<SubSessionEvent[]>([]);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<SubSession>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const canLoad = !!workspaceHash && !!sessionName;
  const list = useRemote<SubSession[]>(api, canLoad ? subSessionsPath(workspaceHash, sessionName!) : null, listRevision);
  const stored = useRemote<SubSessionEvent[]>(api, selected && canLoad ? subSessionEventsPath(selected.subSessionId, workspaceHash, sessionName!) : null, eventRevision);
  const loaded = useRef<string>('');
  const replay = useMemo(() => subSessionBlocks(events), [events]);

  useEffect(() => {
    // Only adopt the stored events once per selection; streaming appends below.
    if (!selected) { setEvents([]); loaded.current = ''; return; }
    if (!stored.data) return;
    const key = `${selected.subSessionId}:${eventRevision}`;
    if (loaded.current === key) return;
    loaded.current = key;
    setEvents(stored.data);
  }, [selected, stored.data, eventRevision]);
  useEffect(() => { setError(stored.error); }, [stored.error]);
  // A run finishing elsewhere should refresh the list without a manual reload;
  // hidden tabs keep quiet so background dashboards do not poll pointlessly.
  useEffect(() => {
    if (!canLoad) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      setListRevision(value => value + 1);
    }, 5000);
    return () => clearInterval(timer);
  }, [canLoad, workspaceHash, sessionName]);

  function open(item: SubSession) {
    if (selected?.subSessionId === item.subSessionId) { setSelected(undefined); setEvents([]); return; }
    setSelected(item); setEvents([]); setError(''); setMessage('');
  }
  async function remove(item: SubSession) {
    await api.request(`/sub-sessions/${encodeURIComponent(item.subSessionId)}?${new URLSearchParams({ workspaceHash, sessionName: sessionName || '' })}`, 'DELETE');
    if (selected?.subSessionId === item.subSessionId) { setSelected(undefined); setEvents([]); }
    setListRevision(value => value + 1);
    notify('子代理会话已删除');
  }
  async function send() {
    const text = message.trim();
    if (!selected || !text || busy) return;
    setBusy(true); setError(''); setMessage('');
    setEvents(current => [...current, { type: 'sub_user', content: text }]);
    try {
      await continueSubSession(api.assetUrl(''), selected.subSessionId, text, workspaceHash, sessionName || '', event => setEvents(current => [...current, event]));
    } catch (cause) {
      setError(errorText(cause));
      setEvents(current => [...current, { type: 'sub_end', status: 'error' }]);
    } finally {
      setBusy(false);
      setListRevision(value => value + 1);
    }
  }
  function refresh() {
    setListRevision(value => value + 1);
    setEventRevision(value => value + 1);
  }
  return <div className="workbench-subagents">
    <section className="workbench-card subagent-list-card">
      <header className="workbench-card-head"><strong>子代理会话</strong><span className="section-note">{canLoad ? `${list.data?.length ?? 0} 个` : '未打开会话'}</span><IconButton label="刷新子代理会话" onClick={refresh}><RefreshCw size="0.875rem" /></IconButton></header>
      {!canLoad ? <p className="panel-empty">打开一个会话后可以查看它的子代理执行记录</p> : <>
        <RemoteState loading={list.loading} error={list.error} />
        {list.data?.length === 0 && <p className="panel-empty">当前会话暂无子代理执行记录</p>}
        <ul className="subagent-list">{list.data?.map(item => <li key={item.subSessionId}>
          <button type="button" className={`subagent-row ${selected?.subSessionId === item.subSessionId ? 'selected' : ''}`} title={subSessionLabel(item)} onClick={() => open(item)}>
            <span className={`subagent-dot ${item.status}`} aria-hidden="true" />
            <span className="subagent-row-main"><strong>{subSessionLabel(item)}</strong><small>{subStatusLabel(item.status)} · {formatSubTime(item.startedAt)} · {item.eventCount} 事件</small></span>
            <ChevronRight size="0.875rem" />
          </button>
          {onOpenTab && <IconButton label={`在标签页打开 ${subSessionLabel(item)}`} className="subagent-open-tab" onClick={() => onOpenTab(item)}><ExternalLink size="0.8125rem" /></IconButton>}
          <IconButton label={`删除 ${subSessionLabel(item)}`} className="subagent-delete" onClick={() => setDeleting(item)}><Trash2 size="0.8125rem" /></IconButton>
        </li>)}</ul>
      </>}
    </section>
    {selected && <section className="workbench-card subagent-replay">
      <header className="workbench-card-head"><strong>{subSessionLabel(selected)}</strong><span className={`subagent-status ${replay.status}`}>{subStatusLabel(replay.status)}</span></header>
      {error && <p className="settings-error" role="alert">{error}</p>}
      <RemoteState loading={stored.loading} error="" />
      {replay.blocks.length ? <div className="subagent-replay-body"><BlockRenderer blocks={replay.blocks} notify={notify} onDiff={onDiff} /></div> : !stored.loading && <p className="panel-empty">没有可回放的内容</p>}
      <footer className="subagent-continue">
        <input aria-label="继续子代理对话" placeholder="继续对话（仅活跃会话可用）…" value={message} disabled={busy} onChange={event => setMessage(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} />
        <Button size="sm" color="primary" isLoading={busy} isDisabled={!message.trim()} onPress={() => void send()}>发送</Button>
      </footer>
    </section>}
    {deleting && <ConfirmAction title="删除子代理会话" onClose={() => setDeleting(undefined)} action={() => remove(deleting)}>
      <p>“{subSessionLabel(deleting)}”将被永久删除，无法恢复。</p>
    </ConfirmAction>}
  </div>;
}
