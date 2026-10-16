import { cloneElement, createContext, isValidElement, useContext, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkBreaks from 'remark-breaks';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { normalizeMathMarkdown } from '../markdown-math';
import { normalizeAlertMarkdown } from '../markdown-alert';
import { LOCAL_FILE_SCHEME, localFilePath, rehypeLocalFileLinks } from '../markdown-links';
import { markdownSchema } from '../markdown-schema';
import { useColorizedFence } from '../highlight';
import { useImagePreview } from './ImagePreview';
import { LinkPopoverProvider, useLinkPopover } from './LinkPopover';
import { Check, ChevronDown, Code2, Copy } from 'lucide-react';
import { IconButton } from './ui';
import { useCollapseAll } from './Motion';

const NoticeContext = createContext<(message: string) => void>(() => {});

// Markdown links that point at workspace files open the local preview instead
// of a browser tab; everything else keeps the new-tab behaviour.
const OpenFileContext = createContext<((path: string) => void) | null>(null);

export async function copyText(text: string, notify: (message: string) => void) {
  try { await navigator.clipboard.writeText(text); notify('已复制'); return true; }
  catch { notify('复制失败，请选择内容手动复制'); return false; }
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const notify = useContext(NoticeContext);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  useCollapseAll(() => setExpanded(false));
  const lines = code.split('\n').length;
  // VS Code's tokenizer paints the block once Monaco is loaded; until then (and
  // for oversized blocks) the fence renders as plain text.
  const highlighted = useColorizedFence(code, language);
  return <div className={`code-block-wrap ${lines > 8 && !expanded ? 'collapsed' : ''}`}>
    <div className="code-block-top"><button type="button" className="code-block-toggle" aria-label={lines > 8 ? `${expanded ? '收起' : '展开'} ${language || 'text'} 代码` : `${language || 'text'} 代码`} aria-expanded={lines > 8 ? expanded : undefined} disabled={lines <= 8} onClick={() => setExpanded(!expanded)}><Code2 size="0.875rem" /><span>{language || 'text'}</span><span className="code-block-meta">{lines} 行</span>{lines > 8 && <ChevronDown size="0.875rem" className={expanded ? 'rotated' : ''} />}</button><IconButton label="复制代码" onClick={() => { void copyText(code, notify).then(success => setCopied(success)); }}>{copied ? <Check size="0.875rem" /> : <Copy size="0.875rem" />}</IconButton></div>
    <div className="code-preview" style={{ height: lines > 8 && !expanded ? '11.0625rem' : 'auto' }}><pre>{highlighted === null ? <code>{code}</code> : <code dangerouslySetInnerHTML={{ __html: highlighted }} />}</pre></div>
    {lines > 8 && <button type="button" className="code-expand" onClick={() => setExpanded(!expanded)}>{expanded ? '收起代码' : `展开全部 ${lines} 行`}<ChevronDown size="0.8125rem" className={expanded ? 'rotated' : ''} /></button>}
  </div>;
}

function MarkdownPre({ children }: { children?: ReactNode }) {
  if (!isValidElement<{ className?: string; children?: ReactNode }>(children)) return <pre>{children}</pre>;
  return <CodeBlock code={String(children.props.children || '').replace(/\n$/, '')} language={/language-([^\s]+)/.exec(children.props.className || '')?.[1] || ''} />;
}

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  const openFile = useContext(OpenFileContext);
  const { show, scheduleHide } = useLinkPopover();
  const path = localFilePath(href);
  if (path && openFile) return <a href="#" className="ai-link ai-file-link" title="打开文件预览" onClick={event => { event.preventDefault(); openFile(path); }}>{children}</a>;
  // Hovering an external link reveals the legacy link toolbar ("浏览器打开",
  // plus "元素界面打开" when running under Electron).
  return <a href={href} className="ai-link" target="_blank" rel="noopener noreferrer" onMouseEnter={event => show(event.currentTarget)} onMouseLeave={scheduleHide}>{children}</a>;
}

function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const preview = useImagePreview();
  if (!preview || !src) return <img src={src} alt={alt} />;
  return <button type="button" className="markdown-image-button" aria-label="放大图片" title="放大图片" onClick={() => preview(src)}><img src={src} alt={alt} /></button>;
}

const components: Components = {
  pre: MarkdownPre,
  a: MarkdownLink,
  img: MarkdownImage,
  table: ({ children }) => <div className="markdown-table-scroll"><table>{children}</table></div>,
  blockquote: ({ children }) => <AlertQuote>{children}</AlertQuote>,
};

const ALERT_MARKER = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i;

// react-markdown blanks any href whose "protocol" is not http/https/mailto/...,
// which kills Windows drive paths (`C:\repo\a.ts`) before we can turn them into
// file previews. Keep those verbatim; everything else still goes through the
// default transform and the sanitize schema.
const urlTransform = (url: string) => url.startsWith(LOCAL_FILE_SCHEME) || localFilePath(url) ? url : defaultUrlTransform(url);

function firstText(node: ReactNode): string | null {
  // Markdown emits whitespace-only text nodes between blocks; skip those so the
  // alert marker at the start of the real content is what we inspect.
  if (typeof node === 'string') return node.trim() ? node : null;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) { for (const child of node) { const found = firstText(child); if (found !== null) return found; } return null; }
  if (isValidElement(node)) return firstText((node.props as { children?: ReactNode }).children);
  return null;
}

function replaceFirstText(node: ReactNode, replace: (text: string) => string, state: { done: boolean }): ReactNode {
  if (state.done) return node;
  if (typeof node === 'string') { if (!node.trim()) return node; state.done = true; return replace(node); }
  if (Array.isArray(node)) return node.map(child => replaceFirstText(child, replace, state));
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    if (props.children === undefined) return node;
    return cloneElement(node as ReactElement<{ children?: ReactNode }>, { children: replaceFirstText(props.children, replace, state) });
  }
  return node;
}

// GitHub `> [!NOTE]` blockquotes become colored alert cards; plain quotes keep
// the default blockquote styling.
function AlertQuote({ children }: { children?: ReactNode }) {
  const text = firstText(children);
  const type = text ? ALERT_MARKER.exec(text)?.[1].toLowerCase() : undefined;
  if (!type) return <blockquote>{children}</blockquote>;
  const stripped = replaceFirstText(children, value => value.replace(ALERT_MARKER, ''), { done: false });
  return <div className={`markdown-alert markdown-alert-${type}`}>{stripped}</div>;
}

export default function Markdown({ text, notify, onOpenFile }: { text: string; notify: (message: string) => void; onOpenFile?: (path: string) => void }) {
  const source = useMemo(() => normalizeAlertMarkdown(normalizeMathMarkdown(text)), [text]);
  return <LinkPopoverProvider><NoticeContext.Provider value={notify}><OpenFileContext.Provider value={onOpenFile ?? null}><div className="block-content"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]} rehypePlugins={[rehypeRaw, rehypeLocalFileLinks, [rehypeSanitize, markdownSchema], rehypeKatex]} urlTransform={urlTransform} components={components}>{source}</ReactMarkdown></div></OpenFileContext.Provider></NoticeContext.Provider></LinkPopoverProvider>;
}
