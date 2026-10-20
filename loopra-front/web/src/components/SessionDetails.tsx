import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { Button, Modal, ModalBody, ModalContent, ModalHeader } from '@nextui-org/react';
import { Check, CircleAlert, Copy, Download, FileText, ListChecks, ListTree, LoaderCircle, Minus, RefreshCw, Square, X } from 'lucide-react';
import { IconButton } from './ui';
import { useMenuPlacement } from '../layout/menu-placement';
import { sessionQuery, type AcpPlanEntry, type AcpSessionState, type LoopraClient } from '../backend';
import type { Session } from '../lib';
import { query, RemoteState, useRemote } from './RemoteControls';
import { promptText } from '../session-prompt';
import Markdown, { copyText } from './Markdown';
import RawSessionRecords from './RawSessionRecords';
export function downloadJson(name: string, value: unknown) { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
const recordTabs = [{ id: 'events', label: '原始记录', Icon: ListTree }, { id: 'prompt', label: '系统提示词', Icon: FileText }] as const;
export default function SessionDetails({ api, session, onClose, initialTab = 'events', notify = () => {} }: { api: LoopraClient; session: Session; onClose: () => void; initialTab?: string; notify?: (message: string) => void }) {
  const [tab, setTab] = useState(initialTab === 'prompt' ? 'prompt' : 'events');
  const [revision, setRevision] = useState({ events: 0, prompt: 0 });
  const [promptView, setPromptView] = useState('read');
  const suffix = sessionQuery(session);
  // Keep both results cached while switching tabs; refresh only the active tab.
  const events = useRemote<unknown[]>(api, `/agent/history/events?${suffix}`, revision.events);
  const prompt = useRemote<{ content?: string; length?: number }>(api, `/agent/prompt?${suffix}`, revision.prompt);
  const state = tab === 'events' ? events : prompt;
  const text = promptText(prompt.data);
  return <Modal isOpen onClose={onClose} size="4xl" placement="center" scrollBehavior="inside" classNames={{ base: 'app-dialog session-record-dialog', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop', closeButton: 'app-dialog-close' }} aria-label="会话记录"><ModalContent>
    <ModalHeader className="app-dialog-header"><div className="session-record-title"><h2>会话记录</h2><span title={session.title}>{session.title}</span></div></ModalHeader>
    <div className="session-record-toolbar"><div className="workbench-tabs" role="tablist" aria-label="会话记录分类">{recordTabs.map(({ id, label, Icon }) => <button key={id} id={`session-record-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls="session-record-panel" onClick={() => setTab(id)}><Icon size="0.9375rem" />{label}</button>)}</div>
      <div className="session-record-tools">{tab === 'events' ? <Button size="sm" variant="light" isDisabled={!events.data?.length} onPress={() => downloadJson(`${session.name}-events.json`, events.data)} startContent={<Download size="0.875rem" />}>导出记录</Button> : <Button size="sm" variant="light" isDisabled={!text} onPress={() => { void copyText(text, notify); }} startContent={<Copy size="0.875rem" />}>复制提示词</Button>}<Button size="sm" variant="light" isLoading={state.loading} onPress={() => setRevision(value => ({ ...value, [tab]: value[tab as keyof typeof value] + 1 }))} startContent={<RefreshCw size="0.875rem" />}>刷新</Button></div>
    </div>
    <ModalBody className="app-dialog-body session-record-body"><div id="session-record-panel" role="tabpanel" aria-labelledby={`session-record-tab-${tab}`}>
      {tab === 'events' ? <>
        <RemoteState {...events} />
        {events.data && <RawSessionRecords messages={events.data} notify={notify} />}
      </> : tab === 'prompt' ? <>
        <RemoteState {...prompt} />
        {prompt.data && <><div className="session-prompt-toolbar"><span>{text.length.toLocaleString()} 字符</span><div role="group" aria-label="提示词显示方式"><button type="button" aria-pressed={promptView === 'read'} onClick={() => setPromptView('read')}>阅读</button><button type="button" aria-pressed={promptView === 'source'} onClick={() => setPromptView('source')}>原文</button></div></div>{text ? promptView === 'read' ? <div className="session-prompt-md loopra-conversation"><Markdown text={promptText(prompt.data)} notify={notify} /></div> : <pre className="session-prompt-source">{text}</pre> : <p className="record-empty">没有可显示的系统提示词。</p>}</>}
      </> : null}
    </div></ModalBody>
  </ModalContent></Modal>;
}
type ProgressStep = { id?: string; index?: number; description: string; status: string; kind?: string; result?: string; evidence?: string };
type Progress = { title: string; status: string; progress?: string; totalSteps?: number; doneSteps?: number; currentStepIndex?: number; blockedReason?: string; completionSummary?: string; verifyCommand?: string; steps?: ProgressStep[] };

// Legacy GoalSteps.vue / ChecklistSteps.vue status maps.
const GOAL_STATUS: Record<string, string> = { ACTIVE: '进行中', PAUSED: '暂停', BLOCKED: '阻塞', COMPLETED: '已完成', CANCELLED: '已取消' };
const CHECKLIST_STATUS: Record<string, string> = { DRAFT: '草稿', ACTIVE: '进行中', PAUSED: '暂停', COMPLETED: '已完成', FAILED: '失败' };
const STEP_STATUS: Record<string, string> = { DONE: '已完成', IN_PROGRESS: '进行中', RUNNING: '进行中', PENDING: '待处理', BLOCKED: '阻塞', SKIPPED: '已跳过', FAILED: '失败' };
export function progressStatusText(status: string, checklist = false) {
  const map = checklist ? CHECKLIST_STATUS : GOAL_STATUS;
  return map[status] || status || '';
}
export function progressStepStatusText(status: string) {
  return STEP_STATUS[status] || status || '';
}

function ProgressCard({ item, checklist, onRefresh, refreshing }: { item: Progress; checklist: boolean; onRefresh: () => void; refreshing: boolean }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const placement = useMenuPlacement(open, root);
  const close = () => { setOpen(false); root.current?.querySelector<HTMLButtonElement>('.progress-trigger')?.focus(); };
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); setOpen(false); root.current?.querySelector<HTMLButtonElement>('.progress-trigger')?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  const steps = item.steps || [];
  const done = item.doneSteps ?? steps.filter(step => step.status === 'DONE').length;
  const total = item.totalSteps ?? steps.length;
  const current = item.currentStepIndex || 0;
  const status = item.status?.toLowerCase() || '';
  const running = ['active', 'running', 'in_progress'].includes(status);
  // Legacy GoalSteps.isCurrent: the running step, else the first pending one when
  // nothing is running. ChecklistSteps compares against currentStepIndex.
  const isCurrent = (step: ProgressStep, index: number) => {
    if (['completed', 'cancelled', 'failed'].includes(status) || step.status === 'DONE' || step.status === 'SKIPPED') return false;
    if (checklist) return index === current - 1;
    if (step.status === 'IN_PROGRESS' || step.status === 'RUNNING') return true;
    if (step.status !== 'PENDING') return false;
    return !steps.some(candidate => candidate.status === 'IN_PROGRESS' || candidate.status === 'RUNNING') && steps.findIndex(candidate => candidate.status === 'PENDING') === index;
  };
  return <div ref={root} className={`session-progress-card ${checklist ? 'is-checklist' : 'is-goal'}`} data-open={open} data-state={status} data-placement={placement.side}
    style={{ '--progress-max-height': `${placement.maxHeight}px` } as CSSProperties} role="group" aria-label={checklist ? '工作流进度' : 'Goal 进度'}>
    <button type="button" className={`background-tasks-trigger progress-trigger${open ? ' active' : ''}`} aria-label={checklist ? '待办清单' : '任务清单'} aria-expanded={open} aria-controls={panelId}
      onClick={() => setOpen(value => !value)}><ListChecks size="0.875rem" aria-hidden="true" /><span>{checklist ? '待办' : '任务'}</span>
      {!!total && <span className="progress-count" aria-label={`已完成 ${done}/${total} 项`}>{done}/{total}</span>}</button>
    <div id={panelId} className="progress-body" role="region" aria-label={item.title || '清单步骤'} hidden={!open}>
      <header className="progress-panel-heading"><span className="progress-panel-label"><ListChecks size="1.0625rem" aria-hidden="true" />{checklist ? '待办清单' : '任务清单'}</span>
        <small className="progress-panel-summary">已完成 {done}/{total} 项{!running && !!status && <> · <span className="progress-state">{progressStatusText(item.status, checklist)}</span></>}</small>
        <IconButton label="刷新清单" onClick={() => { if (!refreshing) onRefresh(); }}><RefreshCw size="1rem" className={refreshing ? 'progress-spinner' : undefined} /></IconButton>
        <IconButton label="关闭清单" onClick={close}><X size="1.0625rem" /></IconButton></header>
      <div className="progress-panel-content">
      <p className="progress-panel-title">{item.title || (checklist ? '待办清单' : '任务清单')}</p>
      {item.blockedReason && <p className="progress-blocked">{item.blockedReason}</p>}
      <ol className="progress-steps">{steps.map((step, index) => {
        const active = isCurrent(step, index);
        const failed = step.status === 'FAILED' || step.status === 'BLOCKED';
        const StepIcon = failed ? CircleAlert : step.status === 'DONE' ? Check : step.status === 'SKIPPED' ? Minus : active && running ? LoaderCircle : Square;
        return <li key={step.id || step.index || index} aria-current={active ? 'step' : undefined} className={`progress-step ${step.status?.toLowerCase()}${active ? ' current' : ''}`}>
          <span className="progress-step-mark" role="img" aria-label={progressStepStatusText(step.status)}><StepIcon size="0.875rem" className={active && running && !failed ? 'progress-spinner' : undefined} /></span>
          <div><span className="progress-step-text">{step.description}</span>{step.kind === 'HITL' && <em>人工审批</em>}{step.kind === 'FORK' && <em>分支</em>}{(step.result || step.evidence) && <small>{step.result || step.evidence}</small>}</div>
        </li>;
      })}</ol>
      {item.verifyCommand && <p className="progress-verify">验证命令: {item.verifyCommand}</p>}
      {item.completionSummary && <p className="progress-summary">{item.completionSummary}</p>}
      </div>
    </div>
  </div>;
}

export function acpPlanProgress(entries: AcpPlanEntry[]): Progress | null {
  if (!entries.length) return null;
  const status = { pending: 'PENDING', in_progress: 'IN_PROGRESS', completed: 'DONE' };
  const done = entries.filter(entry => entry.status === 'completed').length;
  return { title: '任务进度', status: done === entries.length ? 'COMPLETED' : 'ACTIVE', totalSteps: entries.length, doneSteps: done,
    steps: entries.map((entry, index) => ({ id: String(index), description: entry.content, status: status[entry.status] || 'PENDING' })) };
}

export function SessionProgress({ api, session, revision, externalPlan }: { api: LoopraClient; session: Session; revision: number; externalPlan?: AcpPlanEntry[] }) {
  const [refreshRevision, setRefreshRevision] = useState(0);
  const refresh = () => setRefreshRevision(value => value + 1);
  const dataRevision = revision + refreshRevision;
  const suffix = query({ workspaceHash: session.workspaceHash });
  const external = !!session.agentId && session.agentId !== 'native';
  const goal = useRemote<Progress | null>(api, external ? null : `/sessions/${encodeURIComponent(session.name || '')}/goal?${suffix}`, dataRevision);
  const checklist = useRemote<Progress | null>(api, external ? null : `/sessions/${encodeURIComponent(session.name || '')}/checklist?${suffix}`, dataRevision);
  const acp = useRemote<AcpSessionState>(api, external ? `/agent/acp-state?${sessionQuery(session)}` : null, dataRevision);
  // Polling clears useRemote's data while loading. Keep the panel mounted so
  // refreshes preserve its open state and the reader's scroll position.
  const snapshot = useRef<{ api: LoopraClient; id: string; goal?: Progress | null; checklist?: Progress | null; acp?: AcpSessionState }>({ api, id: session.id });
  if (snapshot.current.api !== api || snapshot.current.id !== session.id) snapshot.current = { api, id: session.id };
  if (goal.data !== undefined) snapshot.current.goal = goal.data;
  if (checklist.data !== undefined) snapshot.current.checklist = checklist.data;
  if (acp.data !== undefined) snapshot.current.acp = acp.data;
  const goalData = snapshot.current.goal, checklistData = snapshot.current.checklist;
  const refreshing = goal.loading || checklist.loading || acp.loading;
  if (external) {
    const plan = acpPlanProgress(externalPlan ?? snapshot.current.acp?.plan ?? []);
    return plan ? <div className="session-progress"><ProgressCard item={plan} checklist={false} onRefresh={refresh} refreshing={refreshing} /></div> : null;
  }
  const items = [goalData, checklistData].filter((item): item is Progress => !!item?.title);
  if (!items.length) return null;
  return <div className="session-progress">{goalData?.title && <ProgressCard item={goalData} checklist={false} onRefresh={refresh} refreshing={refreshing} />}{checklistData?.title && <ProgressCard item={checklistData} checklist onRefresh={refresh} refreshing={refreshing} />}</div>;
}
