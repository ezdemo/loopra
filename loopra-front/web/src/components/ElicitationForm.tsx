import { useEffect, useRef, useState } from 'react';
import { elicitationContent, elicitationError, elicitationOptions, elicitationPages, elicitationPageError, type ElicitationRequest } from '../elicitation';
import '../elicitation.css';

export default function ElicitationForm({ request, onAnswer }: {
  request: ElicitationRequest;
  onAnswer: (action: 'accept' | 'decline', content: Record<string, unknown>) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [index, setIndex] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const pages = elicitationPages(request);
  const current = Math.min(index, Math.max(0, pages.length - 1));
  const last = current >= pages.length - 1;
  useEffect(() => { if (body.current) body.current.scrollTop = 0; }, [current]);
  const navigate = (next: number) => { setIndex(next); setError(''); };
  const change = (name: string, value: unknown) => { setAnswers(current => ({ ...current, [name]: value })); setError(''); };
  async function submit(action: 'accept' | 'decline') {
    const invalid = action === 'accept' ? elicitationError(request, answers) : '';
    if (invalid) {
      const invalidPage = pages.findIndex(page => elicitationPageError(request, page, answers));
      if (invalidPage >= 0) setIndex(invalidPage);
      setError(invalid); return;
    }
    setBusy(true); setError('');
    try { await onAnswer(action, action === 'accept' ? elicitationContent(request, answers) : {}); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); }
  }
  return <form className="choice-popup elicitation-form" role="dialog" aria-label="Agent 提问" onSubmit={event => { event.preventDefault(); if (last) void submit('accept'); else navigate(current + 1); }}>
    <header className="choice-popup-head"><span className="choice-progress" aria-live="polite">{pages.length > 1 ? `问题 ${current + 1} / ${pages.length}` : 'Agent 提问'}</span></header>
    <div className="elicitation-fields" ref={body} role="region" aria-label="当前问题内容" tabIndex={0}>
      <p className="elicitation-message">{request.message || '请回答以下问题'}</p>
      {(pages[current]?.fields || []).map(([name, field]) => {
        const label = field.title || name;
        const required = request.schema.required?.includes(name);
        const options = elicitationOptions(field.type === 'array' ? field.items || {} : field);
        const choices = field.type === 'boolean' ? [{ const: true, title: '是' }, { const: false, title: '否' }] : options;
        const selected = answers[name];
        return <fieldset className="elicitation-field" key={name} disabled={busy}>
          <legend>{label}{required && <span className="elicitation-required" aria-label="必答"> *</span>}</legend>
          {field.description && <p className="choice-desc">{field.description}</p>}
          {choices.length > 0 ? <div className="choice-popup-options" role={field.type === 'array' ? 'group' : 'radiogroup'} aria-label={label}>
            {choices.map((option, index) => {
              const active = field.type === 'array' ? Array.isArray(selected) && selected.includes(option.const) : selected === option.const;
              return <button type="button" role={field.type === 'array' ? 'checkbox' : 'radio'} aria-checked={active} key={index}
                className={`choice-popup-option ${active ? 'is-selected' : ''}`} onClick={() => change(name, field.type === 'array'
                  ? active ? (selected as unknown[]).filter(value => value !== option.const) : [...(Array.isArray(selected) ? selected : []), option.const]
                  : option.const)}>
                <span className="choice-index">{index + 1}</span><span className="choice-popup-label"><strong>{option.title || String(option.const)}</strong>{'description' in option && option.description && <small>{option.description}</small>}</span>
                {active && <span aria-hidden="true">✓</span>}
              </button>;
            })}
          </div> : field.type === 'number' || field.type === 'integer' ? <input className="elicitation-input" type="number" aria-label={label} min={field.minimum} max={field.maximum}
            step={field.type === 'integer' ? 1 : 'any'} value={typeof selected === 'number' && Number.isFinite(selected) ? selected : ''} onChange={event => change(name, event.target.value === '' ? undefined : event.target.valueAsNumber)} />
            : field._meta?.codex?.isSecret ? <input className="elicitation-input" type="password" autoComplete="off" aria-label={label} value={String(selected ?? '')} onChange={event => change(name, event.target.value)} />
            : <textarea className="elicitation-input" aria-label={label} rows={2} maxLength={field.maxLength} value={Array.isArray(selected) ? selected.join('\n') : String(selected ?? '')}
              placeholder={field.type === 'array' ? '每行填写一项' : '输入你的回答'} onChange={event => change(name, field.type === 'array' ? event.target.value.split('\n').filter(Boolean) : event.target.value)} />}
        </fieldset>;
      })}
    </div>
    {error && <p className="elicitation-error" role="alert">{error}</p>}
    <footer className="choice-popup-foot"><button type="button" className="elicitation-skip" disabled={busy} onClick={() => void submit('decline')}>跳过</button>
      {pages.length > 1 && <button type="button" className="elicitation-prev" disabled={busy || current === 0} onClick={() => navigate(current - 1)}>← 上一题</button>}
      {last ? <button key="submit" type="submit" className="elicitation-submit" disabled={busy}>{busy ? '提交中…' : '提交'}</button>
        : <button key="next" type="button" className="elicitation-next" disabled={busy} onClick={event => { event.preventDefault(); navigate(current + 1); }}>下一题 →</button>}</footer>
  </form>;
}
