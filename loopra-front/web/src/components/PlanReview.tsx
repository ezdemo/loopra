import { useState } from 'react';
import { Button } from '@nextui-org/react';
import { Check, ChevronDown, FileText, X } from 'lucide-react';
import { Collapse } from './Motion';
import Markdown from './Markdown';

// Mirrors the legacy Chat.vue plan-review band: shows the live plan-mode state,
// lets the user approve a submitted plan for execution, and exits plan mode.
export default function PlanReview({ pendingPlan, busy, onApprove, onExit, notify }: { pendingPlan?: string; busy: boolean; onApprove: () => void; onExit: () => void; notify: (message: string) => void }) {
  const [open, setOpen] = useState(true);
  return <section className="plan-review-band" aria-label="计划模式">
    <div className="plan-review-head">
      <FileText size="1rem" className="plan-review-icon" />
      <strong>计划模式</strong>
      <span className="plan-review-status">{pendingPlan ? '待审查' : '只读探索'}</span>
      {pendingPlan && <button type="button" className="plan-review-chevron" aria-label={open ? '收起计划' : '展开计划'} aria-expanded={open} onClick={() => setOpen(current => !current)}><ChevronDown size="0.875rem" className={open ? 'rotated' : ''} /></button>}
      <div className="plan-review-actions">
        {pendingPlan && <Button size="sm" color="primary" className="plan-approve-btn" isDisabled={busy} startContent={<Check size="0.8125rem" />} onPress={onApprove}>批准并执行</Button>}
        <Button isIconOnly size="sm" variant="light" className="plan-exit-btn" title="退出计划模式" aria-label="退出计划模式" isDisabled={busy} onPress={onExit}><X size="1rem" /></Button>
      </div>
    </div>
    {pendingPlan && <Collapse open={open}><div className="plan-review-body"><div className="plan-review-content"><Markdown text={pendingPlan} notify={notify} /></div></div></Collapse>}
  </section>;
}
