import { Collapse, Disclosure, Enter, useCollapseAll } from './Motion';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlignLeft, ChevronRight, Copy, GitBranch, Pencil, Undo2 } from 'lucide-react';
import type { ChatBlock, Message } from '../chat';
import { formatTurnDuration, splitAssistantBlocks, splitUserContext } from '../chat';
import { ESTIMATED_MESSAGE_HEIGHT, VIRTUALIZATION_THRESHOLD, virtualMessageWindow } from '../chat-window';
import type { Session } from '../lib';
import { getSessionMessages } from '../lib';
import { IconButton } from './ui';
import BlockRenderer from './BlockRenderer';
import type { BlockActions } from './BlockRenderer';
import { ImagePreviewProvider, useImagePreview } from './ImagePreview';
import { copyText } from './Markdown';
import { messageFileStats } from '../file-stats';

type MessageActions = BlockActions & { onEdit: (text: string) => void; onBranch: (id: string) => void; onRollback: (message: Message) => void; busy: boolean; onRawEvents?: () => void };
type MessageViewActions = MessageActions & { canManageHistory: boolean };

function UserImages({ images }: { images: string[] }) {
  const preview = useImagePreview();
  return <div className="user-images">{images.map((src, index) => <button type="button" key={index} className="user-image-button" aria-label={`预览图片 ${index + 1}`} onClick={() => preview?.(src)}><img className="user-image" src={src} alt={`图片 ${index + 1}`} /></button>)}</div>;
}

function UserMessage({ message, onEdit, onRollback, busy, notify, onRawEvents, canManageHistory }: { message: Message } & MessageViewActions) {
  const [expanded, setExpanded] = useState(false);
  useCollapseAll(() => setExpanded(false));
  const { context, text } = splitUserContext(message.text);
  const compacted = message.text.startsWith('[历史上下文折叠');
  if (compacted) return <Enter as="article" className="msg compacted-message" data-message-id={message.id}><div className="compacted-body"><Disclosure className="compacted-summary" heading={<><AlignLeft size="0.9375rem" /><strong>较早对话已压缩</strong><span>查看摘要</span><ChevronRight size="0.875rem" /></>}><pre>{message.text.replace(/^[\s\S]*?<compacted-summary>\s*|\s*<\/compacted-summary>[\s\S]*$/g, '')}</pre></Disclosure>{onRawEvents && <button type="button" className="compacted-raw-btn" onClick={onRawEvents}>查看原始记录</button>}</div></Enter>;
  return <Enter as="article" className="msg user" aria-label="用户消息" data-message-id={message.id}><div className="msg-body user-body">
    {context && <Disclosure className="user-auto-message" heading={<>附加上下文<ChevronRight size="0.8125rem" /></>}><pre>{context}</pre></Disclosure>}
    <div className="msg-text">{text.length > 300 ? text.slice(0, 300) : text}{!expanded && text.length > 300 && '…'}<Collapse open={expanded && text.length > 300}>{text.slice(300)}</Collapse></div>
    {text.length > 300 && <button type="button" className="user-expand-btn" onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : '展开全部'}</button>}
    {!!message.images?.length && <UserImages images={message.images} />}
    <footer className="msg-footer"><time className="msg-time">{message.time}</time><span className="msg-actions">{canManageHistory && <>{(message.rollbackId || message.rollbackTimestamp) && <button aria-label="撤回到此消息" disabled={busy} onClick={() => onRollback(message)}><Undo2 size={13} /></button>}<IconButton label="重新编辑消息" onClick={() => onEdit(text)}><Pencil size="0.8125rem" /></IconButton></>}<IconButton label="复制消息" onClick={() => { void copyText(message.text, notify); }}><Copy size="0.8125rem" /></IconButton></span></footer>
  </div></Enter>;
}

function AssistantMessage({ message, streaming, showDuration = true, canManageHistory, ...actions }: { message: Message; streaming: boolean; showDuration?: boolean } & MessageViewActions) {
  const [expanded, setExpanded] = useState(false);
  useCollapseAll(() => setExpanded(false));
  const [clock, setClock] = useState(Date.now());
  // Choices are answered in the composer popup and render nothing themselves, so
  // they must not act as a folding boundary: until the final body arrives the
  // already-run 思考/工具 stay visible, exactly as they were before the question.
  const blocks: ChatBlock[] = useMemo(() => message.blocks?.length ? message.blocks : message.text ? [{ id: message.id + '-text', type: 'content', content: message.text }] : [], [message.blocks, message.text, message.id]);
  const { process, final } = useMemo(() => splitAssistantBlocks(blocks.filter(block => block.type !== 'choice')), [blocks]);
  useEffect(() => {
    if (!streaming) return;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [streaming]);
  // A replayed run has no trustworthy end time while it streams, so its header
  // reads "思考过程" instead of a duration that would keep counting after a stop.
  const elapsed = showDuration && message.startedAt ? Math.max(0, (message.finishedAt || clock) - message.startedAt) : null;
  const duration = elapsed === null ? '' : formatTurnDuration(elapsed);
  const stats = messageFileStats(blocks);
  const answerText = final.map(block => block.type === 'content' ? block.content : block.type === 'tool_call' ? block.result || '' : '').filter(Boolean).join('\n\n') || message.text;
  const processId = 'process-' + message.id;
  // A pending choice keeps the turn's "用时" summary on screen even when nothing
  // has folded into it yet; on approval the same bubble simply keeps streaming.
  const pending = blocks.some(block => block.type === 'choice' && !block.selected);
  if (!blocks.length && !streaming) return null;
  return <Enter as="article" className="msg assistant" aria-label="助手消息" data-message-id={message.id}><div className="msg-body assistant-body">
    {(process.length > 0 || streaming || pending) && <section className={`assistant-process-summary ${streaming ? 'live' : ''}`}>
      <button type="button" className="assistant-process-toggle" aria-expanded={expanded && process.length > 0} aria-controls={process.length ? processId : undefined} disabled={!process.length} onClick={() => setExpanded(!expanded)}><span>{duration ? '用时 ' + duration : '思考过程'}</span><ChevronRight size="0.875rem" className={expanded ? 'rotated-right' : ''} /></button>
      <Collapse open={expanded && process.length > 0} id={processId} className="assistant-process-detail"><BlockRenderer blocks={process} {...actions} /></Collapse>
    </section>}
    <BlockRenderer blocks={final} streaming={streaming} {...actions} />
    {streaming && !message.text && <div className="thinking" role="status"><i /><i /><i /><span>正在准备回复…</span></div>}
    {!streaming && <footer className="msg-footer"><span className="msg-time-group"><time className="msg-time">{message.time}</time>{stats.edited.length > 0 && <button type="button" className="msg-file-stat" title={stats.edited.join('\n')} onClick={() => actions.onDiff?.(stats.edited[0])}>修改 {stats.edited.length} 文件</button>}{stats.created.length > 0 && <button type="button" className="msg-file-stat" title={stats.created.join('\n')} onClick={() => actions.onDiff?.(stats.created[0])}>新增 {stats.created.length} 文件</button>}</span><span className="msg-actions"><IconButton label="复制回复" onClick={() => { void copyText(answerText, actions.notify); }}><Copy size="0.8125rem" /></IconButton>{canManageHistory && <button type="button" className="msg-action-button" aria-label="继续到新会话" title="继续到新会话" disabled={actions.busy} onClick={() => actions.onBranch(message.id)}><GitBranch size="0.875rem" /></button>}</span></footer>}
  </div></Enter>;
}

// Long sessions mount only the visible slice (legacy `Chat.vue` virtualWindow);
// measured heights keep the spacer sizes honest and the scroll position stable.
export function Messages({ session, loading, scrollRef, offsetsRef, showDuration = true, ...actions }: { session: Session; loading: boolean; scrollRef?: { current: HTMLElement | null }; offsetsRef?: { current: number[] }; showDuration?: boolean } & MessageActions) {
  const messages = getSessionMessages(session);
  const canManageHistory = !session.agentId || session.agentId === 'native';
  const last = messages[messages.length - 1];
  const virtualized = messages.length > VIRTUALIZATION_THRESHOLD;
  const heights = useRef(new Map<string, number>());
  const nodes = useRef(new Map<string, HTMLElement>());
  const observer = useRef<ResizeObserver | null>(null);
  const [revision, setRevision] = useState(0);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });

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
  useEffect(() => { heights.current.clear(); setRevision(value => value + 1); }, [session.id]);

  const heightsList = useMemo(() => messages.map(message => heights.current.get(String(message.id)) || ESTIMATED_MESSAGE_HEIGHT), [messages, revision]);
  const view = useMemo(() => virtualMessageWindow(heightsList, viewport.top, viewport.height), [heightsList, viewport.top, viewport.height]);
  useEffect(() => { if (offsetsRef) offsetsRef.current = view.offsets; }, [offsetsRef, view.offsets]);

  const render = (message: Message) => message.role === 'user'
    ? <UserMessage key={message.id} message={message} canManageHistory={canManageHistory} {...actions} />
    : <AssistantMessage key={message.id} message={message} streaming={loading && message.id === last?.id} showDuration={showDuration} canManageHistory={canManageHistory} {...actions} />;
  const visible = virtualized ? messages.slice(view.start, view.end) : messages;
  return <div className="loopra-conversation" aria-label="聊天内容"><ImagePreviewProvider><div className="message-list">
    {virtualized && view.topHeight > 0 && <div className="virtual-spacer" style={{ height: view.topHeight }} aria-hidden="true" />}
    {virtualized ? visible.map(message => <div key={message.id} ref={node => measure(String(message.id), node)} className="virtual-message-item">{render(message)}</div>) : visible.map(render)}
    {virtualized && view.bottomHeight > 0 && <div className="virtual-spacer" style={{ height: view.bottomHeight }} aria-hidden="true" />}
  </div></ImagePreviewProvider></div>;
}
