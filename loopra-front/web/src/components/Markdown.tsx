import { createContext, isValidElement, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import { Check, ChevronDown, Code2, Copy } from 'lucide-react';
import { IconButton } from './ui';

for (const [name, syntax] of Object.entries({ javascript, typescript, python, bash, json, css, xml })) hljs.registerLanguage(name, syntax);
hljs.registerAliases(['jsx'], { languageName: 'javascript' });
hljs.registerAliases(['tsx'], { languageName: 'typescript' });
const NoticeContext = createContext<(message: string) => void>(() => {});

export async function copyText(text: string, notify: (message: string) => void) {
  try { await navigator.clipboard.writeText(text); notify('已复制'); return true; }
  catch { notify('复制失败，请选择内容手动复制'); return false; }
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const notify = useContext(NoticeContext);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const lines = code.split('\n').length;
  const highlighted = useMemo(() => hljs.getLanguage(language) ? hljs.highlight(code, { language, ignoreIllegals: true }).value : null, [code, language]);
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

const components: Components = {
  pre: MarkdownPre,
  a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
  table: ({ children }) => <div className="markdown-table-scroll"><table>{children}</table></div>,
};

export default function Markdown({ text, notify }: { text: string; notify: (message: string) => void }) {
  return <NoticeContext.Provider value={notify}><div className="block-content"><ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>{text}</ReactMarkdown></div></NoticeContext.Provider>;
}
