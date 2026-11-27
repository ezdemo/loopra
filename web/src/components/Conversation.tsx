import { Collapse, Disclosure, Enter, useCollapseAll } from './Motion';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlignLeft, ChevronRight, Copy, GitBranch, Pencil, Undo2 } from 'lucide-react';
import type { ChatBlock, Message, MessageDocument } from '../chat';
import { formatTurnDuration, splitAssistantBlocks, splitUserAttachments, splitUserContext } from '../chat';
import { ESTIMATED_MESSAGE_HEIGHT, VIRTUALIZATION_THRESHOLD, virtualMessageWindow } from '../chat-window';
import type { Session } from '../lib';
import { getSessionMessages } from '../lib';
import { IconButton } from './ui';
import PixelLoader from './PixelLoader';
import BlockRenderer from './BlockRenderer';
import type { BlockActions } from './BlockRenderer';
import { ImagePreviewProvider } from './ImagePreview';
import { copyText } from './Markdown';
import MessageContext from './MessageContext';
import { messageFileStats } from '../file-stats';
import { messageWebSources } from '../web-sources';
import WebSources from './WebSources';

type MessageActions = BlockActions & { onEdit?: (text: string, documents?: MessageDocument[]) => void; onBranch?: (id: string) => void; onRollback?: (message: Message) => void; busy: boolean; onRawEvents?: () => void };
type MessageViewActions = MessageActions & { canManageHistory: boolean };

// App callbacks capture the current workspace/session. Keep event identities
// stable for memoized messages, while dispatching to the latest committed view.
function useMessageActions(actions: MessageActions): MessageActions {
  const latest = useRef(actions);
  useLayoutEffect(() => { latest.current = actions; });
  const handlers = useMemo(() => ({
    notify: (text: string) => latest.current.notify(text),
    onEdit: (text: string, documents?: MessageDocument[]) => latest.current.onEdit?.(text, documents),
    onBranch: (id: string) => latest.current.onBranch?.(id),
    onRollback: (message: Message) => latest.current.onRollback?.(message),
    onOpenFile: (path: string) => latest.current.onOpenFile?.(path),
    onDiff: (path: string, diff?: string) => latest.current.onDiff?.(path, diff),
    onRevert: (changes: Parameters<NonNullable<BlockActions['onRevert']>>[0]) => latest.current.onRevert!(changes),
    onRawEvents: () => latest.current.onRawEvents?.(),
  }), []);
  return {
    ...handlers, busy: actions.busy,
    onEdit: actions.onEdit ? handlers.onEdit : undefined,
    onBranch: actions.onBranch ? handlers.onBranch : undefined,
    onRollback: actions.onRollback ? handlers.onRollback : undefined,
    onOpenFile: actions.onOpenFile ? handlers.onOpenFile : undefined,
    onDiff: actions.onDiff ? handlers.onDiff : undefined,
    onRevert: actions.onRevert ? handlers.onRevert : undefined,
    onRawEvents: actions.onRawEvents ? handlers.onRawEvents : undefined,
  };
}

const UserMessage = memo(function UserMessage({ message, onEdit, onRollback, busy, notify, onRawEvents, canManageHistory }: { message: Message } & MessageViewActions) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  useCollapseAll(() => setExpanded(false));
  const { text: body, documents } = splitUserAttachments(message.text);
  const { context, text } = splitUserContext(body);
  const compacted = message.text.startsWith('[历史上下文折叠');
  if (compacted) return <Enter as="article" className="msg compacted-message" data-message-id={message.id}><div className="compacted-body"><Disclosure className="compacted-summary" heading={<><AlignLeft size="0.9375rem" /><strong>{t('chat.compactedTitle')}</strong><span>{t('chat.viewSummary')}</span><ChevronRight size="0.875rem" /></>}><pre>{message.text.replace(/^[\s\S]*?<compacted-summary>\s*|\s*<\/compacted-summary>[\s\S]*$/g, '')}</pre></Disclosure>{onRawEvents && <button type="button" className="compacted-raw-btn" onClick={onRawEvents}>{t('chat.viewRawEvents')}</button>}</div></Enter>;
  return <Enter as="article" className="msg user" aria-label={t('chat.userMessage')} data-message-id={message.id}><div className="msg-body user-body">
    <MessageContext context={context} documents={documents} images={message.images} />
    <div className="msg-text">{text.length > 300 ? text.slice(0, 300) : text}{!expanded && text.length > 300 && '…'}<Collapse open={expanded && text.length > 300}>{text.slice(300)}</Collapse></div>
    {text.length > 300 && <button type="button" className="user-expand-btn" onClick={() => setExpanded(!expanded)}>{expanded ? t('chat.collapse') : t('chat.expandAll')}</button>}
    <footer className="msg-footer"><time className="msg-time">{message.time}</time><span className="msg-actions">{canManageHistory && <>{onRollback && (message.rollbackId || message.rollbackTimestamp) && <button aria-label={t('chat.rollbackHere')} disabled={busy} onClick={() => onRollback(message)}><Undo2 size={13} /></button>}{onEdit && <IconButton label={t('chat.editMessageAgain')} onClick={() => onEdit(text, documents)}><Pencil size="0.8125rem" /></IconButton>}</>}<IconButton label={t('chat.copyMessage')} onClick={() => { void copyText(message.text, notify); }}><Copy size="0.8125rem" /></IconButton></span></footer>
  </div></Enter>;
});

function TurnDuration({ startedAt, finishedAt, streaming, showDuration }: { startedAt?: number; finishedAt?: number; streaming: boolean; showDuration: boolean }) {
  const { t } = useTranslation();
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    if (!streaming || !showDuration || !startedAt || finishedAt) return;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [streaming, showDuration, startedAt, finishedAt]);
  const elapsed = showDuration && startedAt ? Math.max(0, (finishedAt || clock) - startedAt) : null;
  return <span>{elapsed === null ? t('chat.thinkingProcess') : t('chat.duration', { duration: formatTurnDuration(elapsed, t) })}</span>;
}

const AssistantMessage = memo(function AssistantMessage({ message, streaming, showDuration = true, canBranch, ...actions }: { message: Message; streaming: boolean; showDuration?: boolean; canBranch: boolean } & MessageActions) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  useCollapseAll(() => setExpanded(false));
  // Choices are answered in the composer popup and render nothing themselves, so
  // they must not act as a folding boundary: until the final body arrives the
  // already-run 思考/工具 stay visible, exactly as they were before the question.
  const blocks: ChatBlock[] = useMemo(() => message.blocks?.length ? message.blocks : message.text ? [{ id: message.id + '-text', type: 'content', content: message.text }] : [], [message.blocks, message.text, message.id]);
  const { process, final } = useMemo(() => splitAssistantBlocks(blocks.filter(block => block.type !== 'choice')), [blocks]);
  const stats = useMemo(() => messageFileStats(blocks), [blocks]);
  const sources = useMemo(() => messageWebSources(blocks), [blocks]);
  const answerText = useMemo(() => final.map(block => block.type === 'content' ? block.content : block.type === 'tool_call' ? block.result || '' : '').filter(Boolean).join('\n\n') || message.text, [final, message.text]);
  const processId = 'process-' + message.id;
  // A pending choice keeps the turn's "用时" summary on screen even when nothing
  // has folded into it yet; on approval the same bubble simply keeps streaming.
  const pending = blocks.some(block => block.type === 'choice' && !block.selected);
  if (!streaming && !process.length && !final.length && !blocks.some(block => block.type === 'choice')) return null;
  return <Enter as="article" className="msg assistant" aria-label={t('chat.assistantMessage')} data-message-id={message.id}><div className="msg-body assistant-body">
    {(process.length > 0 || streaming || pending || sources.length > 0) && <section className={`assistant-process-summary ${streaming ? 'live' : ''}`}>
      <div className="assistant-process-head">
        <button type="button" className="assistant-process-toggle" aria-expanded={expanded && process.length > 0} aria-controls={process.length ? processId : undefined} disabled={!process.length} onClick={() => setExpanded(!expanded)}><TurnDuration startedAt={message.startedAt} finishedAt={message.finishedAt} streaming={streaming} showDuration={showDuration} /><ChevronRight size="0.875rem" className={expanded ? 'rotated-right' : ''} /></button>
        {sources.length > 0 && <WebSources sources={sources} />}
      </div>
      <Collapse open={expanded && process.length > 0} id={processId} className="assistant-process-detail"><BlockRenderer blocks={process} {...actions} /></Collapse>
    </section>}
    <BlockRenderer blocks={final} streaming={streaming} {...actions} />
    {streaming && <div className="thinking" role="status"><PixelLoader /><span>{message.text ? t('chat.processing') : t('chat.preparingReply')}</span></div>}
    {!streaming && <footer className="msg-footer"><span className="msg-time-group"><time className="msg-time">{message.time}</time>{stats.edited.length > 0 && <button type="button" className="msg-file-stat" title={stats.edited.join('\n')} onClick={() => actions.onDiff?.(stats.edited[0])}>{t('chat.modifiedFiles', { count: stats.edited.length })}</button>}{stats.created.length > 0 && <button type="button" className="msg-file-stat" title={stats.created.join('\n')} onClick={() => actions.onDiff?.(stats.created[0])}>{t('chat.createdFiles', { count: stats.created.length })}</button>}</span><span className="msg-actions"><IconButton label={t('chat.copyReply')} onClick={() => { void copyText(answerText, actions.notify); }}><Copy size="0.8125rem" /></IconButton>{canBranch && actions.onBranch && <button type="button" className="msg-action-button" aria-label={t('chat.continueBranch')} title={t('chat.continueBranchTitle')} disabled={actions.busy} onClick={() => actions.onBranch?.(message.id)}><GitBranch size="0.875rem" /></button>}</span></footer>}
  </div></Enter>;
});

// Long sessions mount only the visible slice (legacy `Chat.vue` virtualWindow);
// measured heights keep the spacer sizes honest and the scroll position stable.
export function Messages({ session, loading, remoteRunning = false, scrollRef, offsetsRef, showDuration = true, onLayout, onCorrectScroll, ...callbacks }: { session: Session; loading: boolean; remoteRunning?: boolean; scrollRef?: { current: HTMLElement | null }; offsetsRef?: { current: number[] }; showDuration?: boolean; onLayout?: () => void; onCorrectScroll?: (delta: number) => void } & MessageActions) {
  const { t } = useTranslation();
  const actions = useMessageActions(callbacks);
  const messages = useMemo(() => getSessionMessages(session), [session.kind, session.messages]);
  const canManageHistory = !session.agentId || session.agentId === 'native';
  const canBranch = canManageHistory || session.agentId === 'codex' || session.agentId === 'claude-code' || session.agentId === 'devin' || session.agentId === 'soloncode';
  const last = messages[messages.length - 1];
  const virtualized = messages.length > VIRTUALIZATION_THRESHOLD;
  const heights = useRef(new Map<string, number>());
  const heightsSession = useRef(session.id);
  if (heightsSession.current !== session.id) {
    heightsSession.current = session.id;
    heights.current.clear();
  }
  const nodes = useRef(new Map<string, HTMLElement>());
  const observer = useRef<ResizeObserver | null>(null);
  const [revision, setRevision] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  const layoutCallback = useRef(onLayout);
  const layoutPositions = useRef(new Map<string, number>());
  const layoutSession = useRef(session.id);
  useLayoutEffect(() => { layoutCallback.current = onLayout; });

  // Follow the scroller so the mounted window tracks the visible region.
  useEffect(() => {
    const element = scrollRef?.current;
    if (!element || !virtualized) return undefined;
    const update = () => setViewport(current => {
      const next = { top: element.scrollTop, height: element.clientHeight };
      return current.top === next.top && current.height === next.height ? current : next;
    });
    update();
    element.addEventListener('scroll', update, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(element);
    return () => { element.removeEventListener('scroll', update); resize.disconnect(); };
  }, [scrollRef, session.id, virtualized]);

  // One shared observer records real heights and only re-renders on real changes.
  useEffect(() => {
    const resize = new ResizeObserver(entries => {
      let changed = false;
      for (const entry of entries) {
        const node = entry.target as HTMLElement;
        const id = node.dataset.virtualMessageId;
        const height = node.getBoundingClientRect().height;
        if (id && height > 0 && Math.abs((heights.current.get(id) || 0) - height) > 0.5) { heights.current.set(id, height); changed = true; }
      }
      if (changed) setRevision(value => value + 1);
    });
    observer.current = resize;
    nodes.current.forEach(node => resize.observe(node));
    return () => { resize.disconnect(); observer.current = null; };
  }, []);

  const measure = useCallback((id: string, node: HTMLElement | null) => {
    const previous = nodes.current.get(id);
    if (previous && previous !== node) observer.current?.unobserve(previous);
    if (!node) { nodes.current.delete(id); return; }
    nodes.current.set(id, node);
    node.dataset.virtualMessageId = id;
    observer.current?.observe(node);
  }, []);

  useEffect(() => {
    const ids = new Set(messages.map(message => String(message.id)));
    let changed = false;
    for (const key of [...heights.current.keys()]) if (!ids.has(key)) { heights.current.delete(key); changed = true; }
    if (changed) setRevision(value => value + 1);
  }, [messages]);
  const fallbackHeights = useMemo(() => {
    const totals = { user: { height: 0, count: 0 }, assistant: { height: 0, count: 0 } };
    for (const message of messages) {
      const measured = heights.current.get(String(message.id));
      if (measured) { totals[message.role].height += measured; totals[message.role].count += 1; }
    }
    return {
      user: totals.user.count ? totals.user.height / totals.user.count : ESTIMATED_MESSAGE_HEIGHT,
      assistant: totals.assistant.count ? totals.assistant.height / totals.assistant.count : ESTIMATED_MESSAGE_HEIGHT,
    };
  }, [messages, revision]);
  const heightsList = useMemo(() => messages.map(message => heights.current.get(String(message.id)) || fallbackHeights[message.role]), [messages, revision, fallbackHeights]);
  const view = useMemo(() => virtualMessageWindow(heightsList, viewport.top, viewport.height), [heightsList, viewport.top, viewport.height]);
  useEffect(() => { if (offsetsRef) offsetsRef.current = view.offsets; }, [offsetsRef, view.offsets]);

  const render = (message: Message) => message.role === 'user'
    ? <UserMessage key={message.id} message={message} canManageHistory={canManageHistory} {...actions} />
    : <AssistantMessage key={message.id} message={message} streaming={(loading || remoteRunning) && message.id === last?.id} showDuration={showDuration} canBranch={canBranch} {...actions} />;
  const visible = virtualized ? messages.slice(view.start, view.end) : messages;

  // Estimated spacer heights are corrected as rows enter the mounted window.
  // Anchor the first overlapping row in content coordinates so those corrections
  // do not throw the transcript back to an earlier turn.
  useLayoutEffect(() => {
    if (layoutSession.current !== session.id) {
      layoutSession.current = session.id;
      layoutPositions.current.clear();
    }
    const element = scrollRef?.current;
    if (!element || !virtualized) {
      layoutPositions.current.clear();
      layoutCallback.current?.();
      return;
    }
    const scrollerTop = element.getBoundingClientRect().top;
    const current = new Map<string, number>();
    for (const message of visible) {
      const id = String(message.id);
      const node = nodes.current.get(id);
      if (node) current.set(id, node.getBoundingClientRect().top + element.scrollTop - scrollerTop);
    }
    let above: string | undefined;
    let anchor: string | undefined;
    for (const message of visible) {
      const id = String(message.id);
      if (!layoutPositions.current.has(id) || !current.has(id)) continue;
      const bottom = (current.get(id) || 0) + (nodes.current.get(id)?.getBoundingClientRect().height || 0);
      if (bottom > element.scrollTop) { anchor = id; break; }
      above = id;
    }
    anchor ||= above;
    if (anchor) {
      const before = layoutPositions.current.get(anchor) || 0;
      const after = current.get(anchor) || 0;
      const delta = after - before;
      if (Math.abs(delta) > 0.5) {
        if (onCorrectScroll) onCorrectScroll(delta);
        else element.scrollTop += delta;
      }
    }
    layoutPositions.current = current;
    layoutCallback.current?.();
  });

  return <div className="loopra-conversation" aria-label={t('chat.content')}><ImagePreviewProvider><div className="message-list">
    {virtualized && view.topHeight > 0 && <div className="virtual-spacer" style={{ height: view.topHeight }} aria-hidden="true" />}
    {virtualized ? visible.map(message => <div key={message.id} ref={node => measure(String(message.id), node)} className="virtual-message-item">{render(message)}</div>) : visible.map(render)}
    {virtualized && view.bottomHeight > 0 && <div className="virtual-spacer" style={{ height: view.bottomHeight }} aria-hidden="true" />}
    {remoteRunning && !loading && last?.role !== 'assistant' && <article className="msg assistant" aria-label={t('chat.assistantMessage')}><div className="msg-body assistant-body"><div className="thinking" role="status"><PixelLoader /><span>{t('chat.preparingReply')}</span></div></div></article>}
  </div></ImagePreviewProvider></div>;
}
