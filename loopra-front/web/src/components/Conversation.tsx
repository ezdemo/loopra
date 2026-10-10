import { Collapse, Disclosure, Enter } from './Motion';
import { useEffect, useMemo, useState } from 'react';
import { AlignLeft, ChevronRight, Copy, GitBranch, Pencil } from 'lucide-react';
import type { ChatBlock, Message } from '../chat';
import { splitAssistantBlocks, splitUserContext } from '../chat';
import type { Session } from '../lib';
import { getSessionMessages } from '../lib';
import { IconButton } from './ui';
import BlockRenderer from './BlockRenderer';
import type { BlockActions } from './BlockRenderer';
import { copyText } from './Markdown';

type MessageActions = BlockActions & { onEdit: (text: string) => void; onBranch: (id: string) => void; busy: boolean };

function UserMessage({ message, onEdit, notify }: { message: Message } & MessageActions) {
  const [expanded, setExpanded] = useState(false);
  const { context, text } = splitUserContext(message.text);
  const compacted = message.text.startsWith('[历史上下文折叠');
  if (compacted) return <Enter as="article" className="msg compacted-message"><Disclosure className="compacted-summary" heading={<><AlignLeft size="0.9375rem" /><strong>较早对话已压缩</strong><span>查看摘要</span><ChevronRight size="0.875rem" /></>}><pre>{message.text.replace(/^[\s\S]*?<compacted-summary>\s*|\s*<\/compacted-summary>[\s\S]*$/g, '')}</pre></Disclosure></Enter>;
  return <Enter as="article" className="msg user" aria-label="用户消息"><div className="msg-body user-body">
    {context && <Disclosure className="user-auto-message" heading={<>附加上下文<ChevronRight size="0.8125rem" /></>}><pre>{context}</pre></Disclosure>}
    <div className="msg-text">{text.length > 300 ? text.slice(0, 300) : text}{!expanded && text.length > 300 && '…'}<Collapse open={expanded && text.length > 300}>{text.slice(300)}</Collapse></div>
    {text.length > 300 && <button type="button" className="user-expand-btn" onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : '展开全部'}</button>}
    <footer className="msg-footer"><time className="msg-time">{message.time}</time><span className="msg-actions"><IconButton label="重新编辑消息" onClick={() => onEdit(text)}><Pencil size="0.8125rem" /></IconButton><IconButton label="复制消息" onClick={() => { void copyText(message.text, notify); }}><Copy size="0.8125rem" /></IconButton></span></footer>
  </div></Enter>;
}

function AssistantMessage({ message, streaming, ...actions }: { message: Message; streaming: boolean } & MessageActions) {
  const [expanded, setExpanded] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const blocks: ChatBlock[] = useMemo(() => message.blocks?.length ? message.blocks : message.text ? [{ id: message.id + '-text', type: 'content', content: message.text }] : [], [message.blocks, message.text, message.id]);
  const { process, final } = useMemo(() => splitAssistantBlocks(blocks), [blocks]);
  useEffect(() => {
    if (!streaming) return;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [streaming]);
  const elapsed = message.startedAt ? Math.max(0, Math.round(((message.finishedAt || clock) - message.startedAt) / 1000)) : null;
  const duration = elapsed === null ? '' : elapsed < 60 ? elapsed + '秒' : Math.floor(elapsed / 60) + '分' + (elapsed % 60 ? elapsed % 60 + '秒' : '');
  const files = blocks.flatMap(block => block.type === 'file_changes' ? block.changes : []);
  const answerText = final.map(block => block.type === 'content' ? block.content : block.type === 'tool_call' ? block.result || '' : block.type === 'choice' ? block.question : '').filter(Boolean).join('\n\n') || message.text;
  const processId = 'process-' + message.id;
  return <Enter as="article" className="msg assistant" aria-label="助手消息"><div className="msg-body assistant-body">
    {(process.length > 0 || streaming) && <section className={`assistant-process-summary ${streaming ? 'live' : ''}`}>
      <button type="button" className="assistant-process-toggle" aria-expanded={expanded && process.length > 0} aria-controls={process.length ? processId : undefined} disabled={!process.length} onClick={() => setExpanded(!expanded)}><span>{duration ? '用时 ' + duration : '思考过程'}</span><ChevronRight size="0.875rem" className={expanded ? 'rotated-right' : ''} />{streaming && <span className="streaming-label"><i />正在生成</span>}</button>
      <Collapse open={expanded && process.length > 0} id={processId} className="assistant-process-detail"><BlockRenderer blocks={process} {...actions} /></Collapse>
    </section>}
    <BlockRenderer blocks={final} {...actions} />
    {streaming && !message.text && <div className="thinking" role="status"><i /><i /><i /><span>正在准备回复…</span></div>}
    {!streaming && <footer className="msg-footer"><span className="msg-time-group"><time className="msg-time">{message.time}</time>{files.length > 0 && <button type="button" className="msg-file-stat" title={files.map(file => file.path).join('\n')} onClick={() => actions.onDiff?.(files[0].path)}>修改 {files.length} 文件</button>}</span><span className="msg-actions"><IconButton label="复制回复" onClick={() => { void copyText(answerText, actions.notify); }}><Copy size="0.8125rem" /></IconButton><button type="button" className="msg-action-button" aria-label="继续到新会话" title="继续到新会话" disabled={actions.busy} onClick={() => actions.onBranch(message.id)}><GitBranch size="0.875rem" /></button></span></footer>}
  </div></Enter>;
}

export function Messages({ session, loading, ...actions }: { session: Session; loading: boolean } & MessageActions) {
  const messages = getSessionMessages(session);
  const last = messages[messages.length - 1];
  return <div className="loopra-conversation" aria-label="聊天内容"><div className="message-list">{messages.map(message => message.role === 'user' ? <UserMessage key={message.id} message={message} {...actions} /> : <AssistantMessage key={message.id} message={message} streaming={loading && message.id === last?.id} {...actions} />)}</div></div>;
}
