import { useMemo, useState } from 'react';
import { ChevronRight, Copy, Search } from 'lucide-react';
import { filterSessionRecords, recordArguments, recordJson, recordPreview, sessionRecords, type RecordKind } from '../session-records';
import { copyText } from './Markdown';

const kinds = [['all', '全部'], ['input', '输入'], ['model', '助手'], ['tool', '工具'], ['context', '上下文']] as const;
export default function RawSessionRecords({ messages, notify }: { messages: unknown[]; notify: (message: string) => void }) {
  const rows = useMemo(() => sessionRecords(messages), [messages]);
  const [kind, setKind] = useState<RecordKind | 'all'>('all');
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(200);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const filtered = useMemo(() => filterSessionRecords(rows, kind, search), [rows, kind, search]);
  return <div className="raw-records">
    <div className="record-filters"><div className="record-kind-filters" role="group" aria-label="记录类型">{kinds.map(([id, label]) => <button type="button" key={id} aria-pressed={kind === id} onClick={() => { setKind(id); setLimit(200); }}>{label}<span>{id === 'all' ? rows.length : rows.filter(row => row.kind === id).length}</span></button>)}</div><label className="record-search"><Search size="0.875rem" /><input aria-label="搜索原始记录" placeholder="搜索内容、命令或结果" value={search} onChange={event => { setSearch(event.target.value); setLimit(200); }} /></label></div>
    <div className="record-list" aria-label="原始记录列表">
      {filtered.slice(0, limit).map(row => <details key={row.id} className={`record-row kind-${row.kind}`} onToggle={event => { if (event.target !== event.currentTarget) return; const open = event.currentTarget.open; setExpanded(current => { const next = new Set(current); if (open) next.add(row.id); else next.delete(row.id); return next; }); }}>
        <summary className="record-row-summary"><ChevronRight className="record-row-chevron" size="0.75rem" /><span className="record-role">{row.label}</span>
          {row.kind === 'tool' ? <><strong className="record-tool-name">{row.name}</strong><code className="record-arguments-preview">{recordPreview(recordArguments(row.args))}</code><span className="record-result-arrow">→</span><span className="record-result-preview">{row.result === undefined ? '未记录结果' : recordPreview(row.result) || '（空结果）'}</span></> : <span className="record-message-preview">{recordPreview(row.text)}</span>}
          {row.timestamp && <time>{new Date(row.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>}
        </summary>
        {expanded.has(row.id) && <div className="record-row-detail"><div className="record-detail-actions"><button type="button" onClick={() => { void copyText(recordJson(row), notify); }}><Copy size="0.8125rem" />复制记录</button></div>
          {row.kind !== 'tool' && <section><h4>内容</h4><pre>{row.text}</pre></section>}
          {row.reasoning && <section><h4>思考</h4><pre>{row.reasoning}</pre></section>}
          {row.args !== undefined && <section><h4>调用参数</h4><pre>{recordArguments(row.args)}</pre></section>}
          {row.result !== undefined && <section><h4>工具结果</h4><pre>{row.result || '（空结果）'}</pre></section>}
          <details className="record-json"><summary>原始 JSON</summary><pre>{recordJson(row)}</pre></details>
        </div>}
      </details>)}
      {filtered.length === 0 && <p className="record-empty">{rows.length ? '没有匹配的记录。' : '这个会话还没有原始记录。'}</p>}
      {filtered.length > limit && <button className="record-load-more" type="button" onClick={() => setLimit(value => value + 200)}>再显示 {Math.min(200, filtered.length - limit)} 条 · 共 {filtered.length} 条</button>}
    </div>
  </div>;
}
