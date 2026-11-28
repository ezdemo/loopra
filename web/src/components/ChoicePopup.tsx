import { Button } from '@nextui-org/react';
import { Check, ChevronLeft, CircleHelp, X } from 'lucide-react';
import { isAskChoice, type ChoiceBlockData } from '../chat';
import { useInteractionDraft, type InteractionDraftCache } from '../useInteractionDraft';

export type ChoiceAnswer = { id: string; value: string; label: string; subId?: string; permissionRequestId?: string };
const choiceKey = (choice: ChoiceBlockData) => choice.permissionRequestId || choice.id;

// Pending ask_choice cards and suspended approvals share this composer popup:
// pick an option, "下一个" for the next question, then "提交" sends the answers.
// An ordinary ask_choice already ended its model turn, so its card can be closed
// and answered in the composer instead; approvals keep the backend waiting and
// cannot be closed.
export default function ChoicePopup({ choices, onSubmit, onDismiss, draftKey = '', drafts }: {
  choices: ChoiceBlockData[];
  onSubmit: (answers: ChoiceAnswer[]) => void;
  onDismiss?: (ids: string[]) => void;
  draftKey?: string;
  drafts?: InteractionDraftCache<ChoiceAnswer>;
}) {
  const [{ index, answers }, setDraft, clearDraft] = useInteractionDraft(draftKey, drafts);
  const setIndex = (next: number) => setDraft({ index: next, answers });
  const current = choices[Math.min(index, choices.length - 1)];
  if (!current) return null;
  const chosen = answers[choiceKey(current)];
  const answered = choices.filter(choice => answers[choiceKey(choice)]).length;
  const last = index >= choices.length - 1;
  const longDescription = (current.description?.length || 0) > 600 || (current.description?.split('\n').length || 0) > 8;
  const pick = (option: ChoiceBlockData['options'][number]) => setDraft({ index, answers: { ...answers, [choiceKey(current)]: { id: current.id, value: option.value || option.title, label: option.title, subId: current.subId, ...(current.permissionRequestId ? { permissionRequestId: current.permissionRequestId } : {}) } } });
  const closable = onDismiss ? choices.filter(isAskChoice) : [];
  const close = () => { clearDraft(); onDismiss?.(closable.map(choice => choice.id)); };
  return <section className="choice-popup" role="dialog" aria-label="待选择" onKeyDown={event => { if (event.key === 'Escape' && closable.length) close(); }}>
    {(choices.length > 1 || closable.length > 0) && <div className="choice-popup-top">
      {choices.length > 1 && <span className="choice-progress">问题 {index + 1} / {choices.length}</span>}
      {closable.length > 0 && <Button isIconOnly size="sm" variant="light" className="choice-close" aria-label="关闭选择" onPress={close}><X size="0.9375rem" /></Button>}
    </div>}
    <header className="choice-popup-head" key={`head-${current.id}`}>
      <div className="choice-question"><CircleHelp size="1rem" /><strong>{current.question}</strong></div>
      {current.description && (longDescription
        ? <details className="choice-details" key={current.id}><summary>查看完整审批参数</summary><pre className="choice-desc" tabIndex={0} aria-label="完整审批参数">{current.description}</pre></details>
        : <p className="choice-desc">{current.description}</p>)}
    </header>
    <div className="choice-popup-options" role="radiogroup" aria-label={current.question} key={`options-${current.id}`}>
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
      {index > 0 && <Button size="sm" variant="light" className="choice-prev" onPress={() => setIndex(index - 1)}><ChevronLeft size="0.9375rem" />上一步</Button>}
      {choices.length > 1 && <span className="choice-popup-count">已选 {answered} / {choices.length}</span>}
      {last
        ? <Button size="sm" color="primary" className="choice-submit" isDisabled={answered < choices.length} onPress={() => { clearDraft(); onSubmit(choices.map(choice => ({ ...answers[choiceKey(choice)], id: choice.id }))); }}>提交</Button>
        : <Button size="sm" color="primary" className="choice-next" isDisabled={!chosen} onPress={() => setIndex(index + 1)}>下一个</Button>}
    </footer>
  </section>;
}
