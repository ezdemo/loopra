import { useState } from 'react';
import { Button } from '@nextui-org/react';
import { Check, ChevronLeft, CircleHelp } from 'lucide-react';
import type { ChoiceBlockData } from '../chat';

export type ChoiceAnswer = { id: string; value: string; label: string; subId?: string };

// The agent is suspended until the choice is answered, so the popup sits over
// the composer and walks every pending question: pick an option, "下一个" for the
// next question, then "提交" sends the answers (sub-agent approvals post instead).
export default function ChoicePopup({ choices, onSubmit }: { choices: ChoiceBlockData[]; onSubmit: (answers: ChoiceAnswer[]) => void }) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, ChoiceAnswer>>({});
  const current = choices[Math.min(index, choices.length - 1)];
  if (!current) return null;
  const chosen = answers[current.id];
  const answered = choices.filter(choice => answers[choice.id]).length;
  const last = index >= choices.length - 1;
  const pick = (option: ChoiceBlockData['options'][number]) => setAnswers(all => ({ ...all, [current.id]: { id: current.id, value: option.value || option.title, label: option.title, subId: current.subId } }));
  return <section className="choice-popup" role="dialog" aria-label="待选择">
    <header className="choice-popup-head">
      {choices.length > 1 && <span className="choice-progress">问题 {index + 1} / {choices.length}</span>}
      <div className="choice-question"><CircleHelp size="1rem" /><strong>{current.question}</strong></div>
      {current.description && <p className="choice-desc">{current.description}</p>}
    </header>
    <div className="choice-popup-options" role="radiogroup" aria-label={current.question}>
      {current.options.map((option, position) => {
        const active = chosen?.label === option.title;
        return <button type="button" role="radio" aria-checked={active} key={option.title} className={`choice-popup-option ${active ? 'is-selected' : ''}`} onClick={() => pick(option)}>
          <span className="choice-index">{position + 1}</span>
          <span className="choice-popup-label"><strong>{option.title}</strong>{option.description && <small>{option.description}</small>}</span>
          {active && <Check size="0.9375rem" />}
        </button>;
      })}
    </div>
    <footer className="choice-popup-foot">
      {index > 0 && <Button size="sm" variant="light" className="choice-prev" onPress={() => setIndex(value => value - 1)}><ChevronLeft size="0.9375rem" />上一步</Button>}
      {choices.length > 1 && <span className="choice-popup-count">已选 {answered} / {choices.length}</span>}
      {last
        ? <Button size="sm" color="primary" className="choice-submit" isDisabled={answered < choices.length} onPress={() => onSubmit(choices.map(choice => answers[choice.id]).filter(Boolean))}>提交</Button>
        : <Button size="sm" color="primary" className="choice-next" isDisabled={!chosen} onPress={() => setIndex(value => value + 1)}>下一个</Button>}
    </footer>
  </section>;
}
