import { useState } from 'react';
import { Button, Modal, ModalContent } from '@nextui-org/react';
import { sessionQuery, type LoopraClient } from '../backend';
import type { Session } from '../lib';
import { ConfirmAction, query, RemoteState, useRemote } from './RemoteControls';
import { promptText } from '../session-prompt';
import Markdown, { copyText } from './Markdown';
export function downloadJson(name: string, value: unknown) { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
export default function SessionDetails({ api, session, onClose, onRolledBack, busy, initialTab = 'events', notify }: { api: LoopraClient; session: Session; onClose: () => void; onRolledBack: (text?: string) => Promise<void>; busy: boolean; initialTab?: string; notify?: (message: string) => void }) {
  const [tab, setTab] = useState(initialTab); const [revision, setRevision] = useState(0); const suffix = sessionQuery(session);
  const events = useRemote<unknown[]>(api, tab === 'events' ? `/agent/history/events?${suffix}` : null, revision);
  const snapshots = useRemote<{ msgId: string; createdAt: number; commitHash: string }[]>(api, tab === 'snapshots' ? `/snapshots?${suffix}` : null, revision);
  // 后端返回 { content, length }；直接渲染对象会让 React 抛错并卸载整页
  const prompt = useRemote<{ content?: string; length?: number }>(api, tab === 'prompt' ? `/agent/prompt?${suffix}` : null, revision);
  const [rollback, setRollback] = useState<string>();
  return <Modal isOpen onClose={onClose} size="4xl" scrollBehavior="inside" aria-label="会话记录"><ModalContent><div className="remote-confirm"><h2>{session.title}</h2><div className="workbench-tabs" role="tablist">{[['events', '原始记录'], ['snapshots', '代码快照'], ['prompt', '实际系统提示词']].map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}<Button size="sm" variant="light" onPress={() => setRevision(value => value + 1)}>刷新</Button></div>{tab === 'events' ? <><RemoteState {...events} /><Button size="sm" isDisabled={!events.data} onPress={() => downloadJson(`${session.name}-events.json`, events.data)}>导出原始记录</Button><pre className="session-raw">{events.data && JSON.stringify(events.data, null, 2)}</pre></> : tab === 'prompt' ? <><RemoteState {...prompt} /><div className="session-prompt-actions"><Button size="sm" variant="light" isDisabled={!prompt.data} onPress={() => { void copyText(promptText(prompt.data), notify || (() => {})); }}>复制提示词</Button></div><div className="session-prompt-md"><Markdown text={promptText(prompt.data)} notify={notify || (() => {})} /></div></> : <><RemoteState {...snapshots} />{snapshots.data?.map(snapshot => <section className="workbench-card" key={snapshot.msgId}><strong>{snapshot.msgId}</strong><p>{new Date(snapshot.createdAt).toLocaleString()}</p><code>{snapshot.commitHash?.slice(0, 12)}</code><Button size="sm" variant="light" color="danger" isDisabled={busy} onPress={() => setRollback(snapshot.msgId)}>回滚到此快照</Button></section>)}{snapshots.data?.length === 0 && <p>暂无代码快照。</p>}</>}</div>{rollback && <ConfirmAction title="回滚会话与代码" onClose={() => setRollback(undefined)} action={async () => { const result = await api.request<{ success: boolean; message: string; rollbackUserText?: string }>(`/snapshots/rollback?${suffix}&${query({ msgId: rollback, rollbackCode: true })}`, 'POST'); if (!result.success) throw new Error(result.message); await onRolledBack(result.rollbackUserText); }} onDone={() => setRevision(value => value + 1)}><p>将恢复项目代码，并撤回该消息及之后的记录。当前未提交的修改可能被覆盖。</p></ConfirmAction>}</ModalContent></Modal>;
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
