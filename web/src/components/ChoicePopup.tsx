import { Button } from '@nextui-org/react';
import { Check, ChevronDown, ChevronLeft, CircleHelp, X } from 'lucide-react';
import type { ChoiceBlockData } from '../chat';
import { useInteractionDraft, type InteractionDraftCache } from '../useInteractionDraft';

export type ChoiceAnswer = { id: string; value: string; label: string; subId?: string; permissionRequestId?: string; custom?: boolean };
const choiceKey = (choice: ChoiceBlockData) => choice.permissionRequestId || choice.id;
const ready = (answer?: ChoiceAnswer) => !!answer && (!answer.custom || !!answer.value.trim());

// Pending ask_choice cards and suspended approvals share this composer popup:
// pick an option, "下一个" for the next question, then "提交" sends the answers
// (permission and sub-agent approvals post to their endpoints instead).
export default function ChoicePopup({ choices, onSubmit, onDismiss, draftKey = '', drafts }: {
  choices: ChoiceBlockData[];
  onSubmit: (answers: ChoiceAnswer[]) => void;
  onDismiss?: (ids: string[]) => void;
  draftKey?: string;
  drafts?: InteractionDraftCache<ChoiceAnswer>;
}) {
  const [{ index, answers, minimized }, setDraft, clearDraft] = useInteractionDraft(draftKey, drafts);
  const update = (patch: Partial<{ index: number; answers: Record<string, ChoiceAnswer>; minimized: boolean }>) => setDraft({ index, answers, minimized, ...patch });
  const setIndex = (next: number) => update({ index: next });
  const current = choices[Math.min(index, choices.length - 1)];
  if (!current) return null;
  const chosen = answers[choiceKey(current)];
  const answered = choices.filter(choice => ready(answers[choiceKey(choice)])).length;
  const last = index >= choices.length - 1;
  const longDescription = (current.description?.length || 0) > 600 || (current.description?.split('\n').length || 0) > 8;
  const answerWith = (value: string, label: string, custom = false): ChoiceAnswer => ({
    id: current.id, value, label, subId: current.subId,
    ...(current.permissionRequestId ? { permissionRequestId: current.permissionRequestId } : {}),
    ...(custom ? { custom: true } : {}),
  });
  const pick = (option: ChoiceBlockData['options'][number]) => update({ answers: { ...answers, [choiceKey(current)]: answerWith(option.value || option.title, option.title) } });
  const custom = (value: string) => update({ answers: { ...answers, [choiceKey(current)]: answerWith(value, value, true) } });
  const submitted = (choice: ChoiceBlockData) => {
    const answer = answers[choiceKey(choice)];
    if (!answer) throw new Error('choice answer missing');
    if (!answer.custom) return { ...answer, id: choice.id };
    const value = answer.value.trim();
    return { ...answer, id: choice.id, value, label: value };
  };
  const submit = () => { clearDraft(); onSubmit(choices.map(submitted)); };
  // ask_choice has already ended its model turn, so a client-side close only
  // resolves the local card; approvals must stay reopenable while the backend waits.
  const closable = choices.some(choice => !choice.permissionRequestId && !choice.subId);
  const close = () => {
    if (closable && onDismiss) { clearDraft(); onDismiss(choices.filter(choice => !choice.permissionRequestId && !choice.subId).map(choice => choice.id)); }
    else update({ minimized: true });
  };

  if (minimized) {
    return <section className="choice-popup choice-popup-collapsed" aria-label="待选择已收起">
      <button type="button" className="choice-reopen" onClick={() => update({ minimized: false })}>
        <CircleHelp size="1rem" /><span className="choice-collapsed-question">{current.question}</span><strong>继续选择</strong>
      </button>
    </section>;
  }

  return <section className="choice-popup" role="dialog" aria-label="待选择" onKeyDown={event => { if (event.key === 'Escape') update({ minimized: true }); }}>
    <div className="choice-popup-top">
      {choices.length > 1 ? <span className="choice-progress">问题 {index + 1} / {choices.length}</span> : <span />}
      <Button isIconOnly size="sm" variant="light" className="choice-minimize choice-collapse" aria-label="收起选择" onPress={() => update({ minimized: true })}><ChevronDown size="0.9375rem" /></Button>
      {closable && onDismiss && <Button isIconOnly size="sm" variant="light" className="choice-minimize choice-close" aria-label="关闭选择" onPress={close}><X size="0.9375rem" /></Button>}
    </div>
    <header className="choice-popup-head" key={`head-${current.id}`}>
      <div className="choice-question"><CircleHelp size="1rem" /><strong>{current.question}</strong></div>
      {current.description && (longDescription
        ? <details className="choice-details" key={current.id}><summary>查看完整审批参数</summary><pre className="choice-desc" tabIndex={0} aria-label="完整审批参数">{current.description}</pre></details>
        : <p className="choice-desc">{current.description}</p>)}
    </header>
    <div className="choice-popup-options" role="radiogroup" aria-label={current.question} key={`options-${current.id}`}>
      {current.options.map((option, position) => {
        const active = !chosen?.custom && chosen?.label === option.title;
        return <button type="button" role="radio" aria-checked={active} key={option.title} className={`choice-popup-option ${active ? 'is-selected' : ''}`} onClick={() => pick(option)}>
          <span className="choice-index">{position + 1}</span>
          <span className="choice-popup-label"><strong>{option.title}</strong>{option.description && <small>{option.description}</small>}</span>
          {active && <Check size="0.9375rem" />}
        </button>;
      })}
      {current.allowCustom && <>
        <button type="button" role="radio" aria-checked={!!chosen?.custom} className={`choice-popup-option ${chosen?.custom ? 'is-selected' : ''}`} onClick={() => custom(chosen?.custom ? chosen.value : '')}>
          <span className="choice-index">{current.options.length + 1}</span>
          <span className="choice-popup-label"><strong>其他</strong><small>输入自定义回答</small></span>
          {chosen?.custom && <Check size="0.9375rem" />}
        </button>
        {chosen?.custom && <input className="choice-custom-input" aria-label="自定义回答" placeholder="输入自定义回答" value={chosen.value} autoFocus onChange={event => custom(event.target.value)} onKeyDown={event => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing || !ready(chosen)) return;
          event.preventDefault();
          if (last) submit();
          else setIndex(index + 1);
        }} />}
      </>}
    </div>
    <footer className="choice-popup-foot">
      {index > 0 && <Button size="sm" variant="light" className="choice-prev" onPress={() => setIndex(index - 1)}><ChevronLeft size="0.9375rem" />上一步</Button>}
      {choices.length > 1 && <span className="choice-popup-count">已选 {answered} / {choices.length}</span>}
      {last
        ? <Button size="sm" color="primary" className="choice-submit" isDisabled={answered < choices.length} onPress={submit}>提交</Button>
        : <Button size="sm" color="primary" className="choice-next" isDisabled={!ready(chosen)} onPress={() => setIndex(index + 1)}>下一个</Button>}
    </footer>
  </section>;
}
