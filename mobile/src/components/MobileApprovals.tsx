import { useState } from 'react';
import { Button } from '@nextui-org/react';
import type { ChoiceBlockData } from '@web/chat';

export default function MobileApprovals({ choices, onAnswer }: { choices: ChoiceBlockData[]; onAnswer: (choice: ChoiceBlockData, value: string, title: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const choice = choices[0];
  if (!choice) return null;
  return <section className="phone-approval" aria-label="需要你的回复"><strong>{choice.question}</strong>{choices.length > 1 && <span className="phone-muted">还有 {choices.length - 1} 项</span>}
    {choice.description && <details><summary>查看详情</summary><pre>{choice.description}</pre></details>}
    <div className="phone-approval-options">{choice.options.map((option, index) => <Button key={`${option.value}-${index}`} variant="bordered" isDisabled={busy} onPress={() => {
      setBusy(true); setError(''); void onAnswer(choice, option.value || option.title, option.title).catch(cause => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false));
    }}>{option.title}</Button>)}</div>{error && <p className="phone-error" role="alert">{error}</p>}</section>;
}
