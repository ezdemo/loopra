import { useState } from 'react';
import { Button, Modal, ModalBody, ModalContent, ModalHeader } from '@nextui-org/react';
import { Copy, Download, FileText, ListTree, RefreshCw } from 'lucide-react';
import { sessionQuery, type LoopraClient } from '../backend';
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

function ProgressCard({ item, checklist }: { item: Progress; checklist: boolean }) {
  const steps = item.steps || [];
  const done = item.doneSteps ?? steps.filter(step => step.status === 'DONE').length;
  const total = item.totalSteps ?? steps.length;
  const current = item.currentStepIndex || 0;
  const percent = checklist ? (total ? Math.min(100, Math.max(0, current / total * 100)) : 0) : (total ? Math.min(100, Math.max(0, done / total * 100)) : 0);
  const heading = checklist ? `第 ${current}/${total} 步` : `${done}/${total}`;
  // Legacy GoalSteps.isCurrent: the running step, else the first pending one when
  // nothing is running. ChecklistSteps compares against currentStepIndex.
  const isCurrent = (step: ProgressStep, index: number) => {
    if (checklist) return index === current - 1;
    if (step.status === 'IN_PROGRESS' || step.status === 'RUNNING') return true;
    if (step.status !== 'PENDING') return false;
    return !steps.some(candidate => candidate.status === 'IN_PROGRESS' || candidate.status === 'RUNNING') && steps.findIndex(candidate => candidate.status === 'PENDING') === index;
  };
  // Legacy renders a compact pill and expands the detail on hover; a collapsed
  // <details> keeps the same footprint without hijacking the composer hover.
  return <details className={`session-progress-card ${checklist ? 'is-checklist' : 'is-goal'}`} aria-label={checklist ? '工作流进度' : 'Goal 进度'}>
    <summary><span className={`progress-dot ${item.status?.toLowerCase()}`} /><strong>{item.title || (checklist ? '清单' : 'Goal')}</strong><span className={`progress-badge ${item.status?.toLowerCase()}`}>{progressStatusText(item.status, checklist)}</span>{!!total && <span className="progress-count">{heading}</span>}</summary>
    <div className="progress-body">
      {!!total && <div className="progress-track" role="progressbar" aria-label={checklist ? '工作流进度' : 'Goal 进度'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}><span style={{ width: `${percent}%` }} /></div>}
      {item.blockedReason && <p className="progress-blocked">{item.blockedReason}</p>}
      <ol className="progress-steps">{steps.map((step, index) => <li key={step.id || step.index || index} className={`progress-step ${step.status?.toLowerCase()}${isCurrent(step, index) ? ' current' : ''}`}>
        <i className={`progress-step-dot ${step.status?.toLowerCase()}`} />
        <div><strong>{step.description}</strong>{step.kind === 'HITL' && <em>人工审批</em>}{step.kind === 'FORK' && <em>分支</em>}<small>{step.result || step.evidence || progressStepStatusText(step.status)}</small></div>
      </li>)}</ol>
      {item.verifyCommand && <p className="progress-verify">验证命令: {item.verifyCommand}</p>}
      {item.completionSummary && <p className="progress-summary">{item.completionSummary}</p>}
    </div>
  </details>;
}

export function SessionProgress({ api, session, revision }: { api: LoopraClient; session: Session; revision: number }) {
  const suffix = query({ workspaceHash: session.workspaceHash });
  const goal = useRemote<Progress | null>(api, `/sessions/${encodeURIComponent(session.name || '')}/goal?${suffix}`, revision);
  const checklist = useRemote<Progress | null>(api, `/sessions/${encodeURIComponent(session.name || '')}/checklist?${suffix}`, revision);
  const items = [goal.data, checklist.data].filter((item): item is Progress => !!item?.title);
  if (!items.length) return null;
  return <div className="session-progress">{goal.data?.title && <ProgressCard item={goal.data} checklist={false} />}{checklist.data?.title && <ProgressCard item={checklist.data} checklist />}</div>;
}
