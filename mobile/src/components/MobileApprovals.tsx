import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import type { ChoiceBlockData } from '@web/chat';

export default function MobileApprovals({ choices, onAnswer }: { choices: ChoiceBlockData[]; onAnswer: (choice: ChoiceBlockData, value: string, title: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const choice = choices[0];
  if (!choice) return null;
  return <section className="phone-approval" aria-label="需要你的回复">
    <div className="approval-heading"><span className="approval-symbol"><ShieldAlert size={18} /></span><div><strong>{choice.question}</strong>{choices.length > 1 && <span>还有 {choices.length - 1} 项</span>}</div></div>
    {choice.description && <details className="approval-details"><summary>查看详情</summary><pre>{choice.description}</pre></details>}
    <div className="phone-approval-options">{choice.options.map((option, index) => <button key={`${option.value}-${index}`} type="button" disabled={busy} onClick={() => {
      setBusy(true); setError(''); void onAnswer(choice, option.value || option.title, option.title).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false));
    }}>{option.title}</button>)}</div>{error && <p className="app-inline-error" role="alert">{error}</p>}</section>;
}
