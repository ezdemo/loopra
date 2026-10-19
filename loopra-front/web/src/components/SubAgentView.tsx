import { useMemo, useRef, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { LoopraClient } from '../backend';
import type { Message } from '../chat';
import type { Session } from '../lib';
import { RemoteState, useRemote } from './RemoteControls';
import { IconButton } from './ui';
import { Messages } from './Conversation';
import { subSessionBlocks, subSessionEventsPath, type SubSessionEvent } from '../sub-sessions';

/**
 * Replay of one sub-agent run, shown as a tab beside the conversation and files.
 * It reuses the main conversation renderer (same process folding, tool cards and
 * Markdown), so a sub-agent reads exactly like the parent turn — without a composer.
 */
export default function SubAgentView({ api, workspaceHash, sessionName, subSessionId, label, notify, onDiff }: {
  api: LoopraClient; workspaceHash: string; sessionName: string; subSessionId: string; label?: string;
  notify: (message: string) => void; onDiff?: (path: string) => void;
}) {
  const [revision, setRevision] = useState(0);
  const [events, setEvents] = useState<SubSessionEvent[]>([]);
  const stored = useRemote<SubSessionEvent[]>(api, subSessionEventsPath(subSessionId, workspaceHash, sessionName), revision);
  const loaded = useRef('');
  const replay = useMemo(() => subSessionBlocks(events), [events]);
  useEffect(() => {
    if (!stored.data) return;
    const key = `${subSessionId}:${revision}`;
    if (loaded.current === key) return;
    loaded.current = key;
    setEvents(stored.data);
  }, [stored.data, revision, subSessionId]);
  useEffect(() => {
    // Follow a live run; a finished (or deleted) one needs no polling.
    if (stored.data && (replay.status !== 'running' || stored.data.length === 0)) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      setRevision(value => value + 1);
    }, 3000);
    return () => clearInterval(timer);
  }, [stored.data, replay.status]);

  // Keep the start clock for the message footer, but the replayed turn never shows
  // a duration: a stop that arrives without `sub_end` would keep counting forever.
  const { startedAt, endedAt } = useMemo(() => {
    const start = events.find(event => event.type === 'sub_start')?.startedAt;
    const end = [...events].reverse().find(event => event.type === 'sub_end')?.endedAt;
    // A finished record without an end time would otherwise report a bogus duration.
    return { startedAt: start && (end || replay.status === 'running') ? start : undefined, endedAt: end };
  }, [events, replay.status]);
  const message = useMemo<Message>(() => ({
    id: `sub-${subSessionId}`,
    role: 'assistant',
    blocks: replay.blocks,
    text: replay.blocks.flatMap(block => block.type === 'content' ? [block.content] : []).join('\n\n'),
    startedAt,
    finishedAt: endedAt,
    // Same clock format as history messages in the main conversation.
    time: startedAt ? new Date(startedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '',
  }), [replay.blocks, startedAt, endedAt, subSessionId]);
  const session = useMemo<Session>(() => ({
    id: `sub-${subSessionId}`, title: label || '', workspace: '', kind: 'remote', messages: [message],
  }), [label, message, subSessionId]);
  const running = replay.status === 'running';

  return <div className="workspace-subagent-view-body">
    <header className="workspace-file-toolbar">
      <span className="workspace-file-path" title={label || subSessionId}>{label || '子代理'}</span>
      <div className="workspace-file-actions">
        <IconButton label="刷新子代理回放" onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} /></IconButton>
      </div>
    </header>
    <div className="workspace-subagent-replay">
      <RemoteState loading={stored.loading && !replay.blocks.length} error={stored.error} />
      {replay.blocks.length
        ? <div className="chat-content"><Messages session={session} loading={running} showDuration={false} notify={notify} onDiff={onDiff}
            onEdit={() => {}} onBranch={() => {}} onRollback={() => {}} busy /></div>
        : !stored.loading && <p className="panel-empty">没有可回放的内容</p>}
    </div>
  </div>;
}
