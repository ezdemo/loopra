import { useEffect, useRef, useState } from 'react';
import { Button, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Radio, RadioGroup, Switch, Tab, Tabs, Textarea } from '@nextui-org/react';
import { AlertCircle, AlarmClock, Pencil, Play, RefreshCw, Trash2 } from 'lucide-react';
import type { LoopraClient, Workspace } from '../backend';
import type { Session } from '../lib';
import { ConfirmAction, errorText, query } from './RemoteControls';
import { Field, SelectField } from './SettingControls';

type Run = { id: string; startedAt: number; finishedAt: number; status: string; sessionName?: string; message?: string; result?: string; error?: string };
type Task = { id: string; name: string; sessionName: string; sessionMode?: 'independent' | 'existing'; message: string; cronExpr: string | null; intervalSec: number | null; enabled: boolean; runCount?: number; nextRunAt?: number; lastResult?: string; lastError?: string; runs?: Run[]; workspaceHash: string };
type ScheduleMode = 'daily' | 'interval' | 'cron';
type TaskFilter = 'all' | 'enabled' | 'paused';
function scheduleLabel(task: Task) {
  const daily = task.cronExpr?.match(/^0 (\d{1,2}) (\d{1,2}) \* \* [*?]$/);
  return daily ? `每天 ${daily[2].padStart(2, '0')}:${daily[1].padStart(2, '0')}` : task.cronExpr || `每 ${task.intervalSec} 秒`;
}
function nextLabel(task: Task) {
  if (!task.enabled) return '已暂停';
  if (!task.nextRunAt || task.nextRunAt < 0) return '等待调度';
  const minutes = Math.max(0, Math.ceil((task.nextRunAt - Date.now()) / 60000));
  if (minutes < 60) return minutes ? `${minutes} 分钟后执行` : '即将执行';
  const hours = Math.floor(minutes / 60), remainder = minutes % 60;
  return `${hours} 小时${remainder ? ` ${remainder} 分钟` : ''}后执行`;
}
export default function SchedulePanel({ api, workspaces, sessions, onOpenSession }: { api: LoopraClient; workspaces: Workspace[]; sessions: Session[]; onOpenSession: (workspaceHash: string, sessionName: string) => void }) {
  const [revision, setRevision] = useState(0);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErrors, setLoadErrors] = useState<string[]>([]);
  const [tab, setTab] = useState('tasks');
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [runTaskFilter, setRunTaskFilter] = useState('all');
  const [draft, setDraft] = useState<Partial<Task>>();
  const [draftWorkspace, setDraftWorkspace] = useState('');
  const [mode, setMode] = useState<ScheduleMode>('daily');
  const [time, setTime] = useState('09:00');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const settingsRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error && settingsRef.current) settingsRef.current.scrollTop = 0; }, [error]);
  const [deleting, setDeleting] = useState<Task>();
  const [selectedTask, setSelectedTask] = useState<Task>();
  const [selectedRun, setSelectedRun] = useState<{ run: Run; task: Task }>();
  const sessionOptions = sessions.flatMap(item => item.workspaceHash === draftWorkspace && item.name ? [{ value: item.name, label: item.title || item.name }] : []);
  const workspaceKey = workspaces.map(item => item.hash).join('\0');
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true); setLoadErrors([]);
    const hashes = workspaceKey ? workspaceKey.split('\0') : [];
    void Promise.allSettled(hashes.map(hash => api.request<Task[]>(`/schedules?${query({ workspaceHash: hash })}`, 'GET', undefined, controller.signal)))
      .then(results => {
        if (!active) return;
        setTasks(results.flatMap((result, index) => result.status === 'fulfilled' ? result.value.map(task => ({ ...task, workspaceHash: hashes[index] })) : []));
        setLoadErrors(results.flatMap((result, index) => result.status === 'rejected' ? [`${hashes[index]}：${errorText(result.reason)}`] : []));
        setLoading(false);
      });
    return () => { active = false; controller.abort(); };
  }, [api, workspaceKey, revision]);
  const refresh = () => setRevision(value => value + 1);
  const workspaceName = (hash: string) => { const item = workspaces.find(workspace => workspace.hash === hash); return item?.displayName || item?.name || hash; };
  const enabledCount = tasks.filter(task => task.enabled).length;
  const visible = tasks.filter(task => filter === 'all' || (filter === 'enabled' ? task.enabled : !task.enabled));
  const runs = tasks.flatMap(task => (task.runs || []).map(run => ({ task, run }))).sort((a, b) => b.run.startedAt - a.run.startedAt);
  const runTasks = tasks.filter(task => task.runs?.length);
  const visibleRuns = runTaskFilter === 'all' ? runs : runs.filter(({ task }) => `${task.workspaceHash}/${task.id}` === runTaskFilter);
  async function act(hash: string, path: string, method = 'POST', body?: unknown) {
    setBusy(true); setError('');
    try { await api.request(`/schedules${path}?${query({ workspaceHash: hash })}`, method, body); return true; }
    catch (cause) { setError(errorText(cause)); return false; }
    finally { setBusy(false); refresh(); }
  }
  function edit(task?: Task) {
    setError(''); setSelectedTask(undefined);
    const hash = task?.workspaceHash || workspaces[0]?.hash || '';
    setDraftWorkspace(hash);
    const daily = task?.cronExpr?.match(/^0 (\d{1,2}) (\d{1,2}) \* \* [*?]$/);
    setMode(daily ? 'daily' : task?.cronExpr ? 'cron' : task ? 'interval' : 'daily');
    setTime(daily ? `${daily[2].padStart(2, '0')}:${daily[1].padStart(2, '0')}` : '09:00');
    setDraft(task || { name: '', sessionMode: 'independent', sessionName: '', message: '', enabled: true, intervalSec: 3600 });
  }
  function save() {
    if (!draft) return;
    if (!draftWorkspace || !draft.name?.trim() || !draft.message?.trim() || (draft.sessionMode !== 'independent' && !draft.sessionName)) { setError('请选择项目，填写任务名称与工作内容；使用已有会话时请选择目标会话'); return; }
    if (mode === 'daily' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) { setError('请选择有效的执行时间'); return; }
    if (mode === 'cron' && !draft.cronExpr?.trim()) { setError('请输入 Cron 表达式'); return; }
    if (mode === 'interval' && (!draft.intervalSec || draft.intervalSec < 60)) { setError('执行间隔不能少于 60 秒'); return; }
    const [hour, minute] = time.split(':').map(Number);
    const cronExpr = mode === 'daily' ? `0 ${minute} ${hour} * * ?` : mode === 'cron' ? draft.cronExpr?.trim() : '';
    void act(draftWorkspace, draft.id ? `/${encodeURIComponent(draft.id)}` : '', draft.id ? 'PUT' : 'POST', { ...draft, cronExpr, intervalSec: mode === 'interval' ? Number(draft.intervalSec) : null }).then(ok => { if (ok) setDraft(undefined); });
  }
  return <>
    <div className="automation-page-heading"><Tabs aria-label="自动化分类" selectedKey={tab} onSelectionChange={key => setTab(String(key))} variant="underlined" className="automation-tabs"><Tab key="tasks" title="定时任务" /><Tab key="runs" title="运行记录" /></Tabs><div className="automation-heading-actions"><Button size="sm" variant="light" isIconOnly aria-label="刷新自动化" onPress={refresh}><RefreshCw size={16} /></Button><Button size="sm" color="primary" onPress={() => edit()} isDisabled={!workspaces.length}>新建自动化</Button></div></div>
    {loadErrors.length > 0 && <p className="settings-error" role="alert">部分项目加载失败：{loadErrors.join('；')}</p>}{error && !draft && <p className="settings-error" role="alert">{error}</p>}
    {tab === 'tasks' ? <><div className="automation-filters">{([['all', `全部 (${tasks.length})`], ['enabled', `已启用 (${enabledCount})`], ['paused', `已暂停 (${tasks.length - enabledCount})`]] as const).map(([key, label]) => <Button key={key} size="sm" variant={filter === key ? 'flat' : 'light'} onPress={() => setFilter(key)} aria-pressed={filter === key}>{label}</Button>)}</div>
      <div className="automation-card-grid">{visible.map(task => <article className="automation-card" key={`${task.workspaceHash}/${task.id}`}><div className="automation-card-heading"><button type="button" onClick={() => setSelectedTask(task)}>{task.name || task.id}</button><Switch size="sm" color="success" aria-label={`${task.enabled ? '暂停' : '启用'} ${task.name}`} isSelected={task.enabled} isDisabled={busy} onValueChange={() => void act(task.workspaceHash, `/${encodeURIComponent(task.id)}/toggle`)} /></div><button type="button" className="automation-card-description" onClick={() => setSelectedTask(task)}>{task.message}</button><div className="automation-card-footer"><span><AlarmClock size={15} />{scheduleLabel(task)}</span><span>{nextLabel(task)}</span></div><div className="automation-card-project">{workspaceName(task.workspaceHash)}</div></article>)}</div>
      {!loading && visible.length === 0 && <p className="panel-empty">{tasks.length ? '没有符合条件的定时任务。' : workspaces.length ? '暂无定时任务，创建一个自动化开始使用。' : '请先添加项目。'}</p>}</> : <>
        <div className="automation-run-toolbar"><SelectField compact label="筛选运行记录" value={runTaskFilter} onChange={setRunTaskFilter} options={[{ value: 'all', label: '全部任务' }, ...runTasks.map(task => ({ value: `${task.workspaceHash}/${task.id}`, label: task.name || task.id }))]} /><span>{visibleRuns.length} 条记录</span></div>
        <div className="automation-record-list">{visibleRuns.map(({ task, run }) => <button type="button" key={`${task.workspaceHash}/${task.id}/${run.id}`} className="automation-record-row" onClick={() => setSelectedRun({ run, task })}><span><strong>{task.name}</strong><small>{workspaceName(task.workspaceHash)} · {new Date(run.startedAt).toLocaleString()}</small></span><span>{run.status === 'error' ? <><AlertCircle size={15} /> 执行失败</> : '执行完成'}</span></button>)}{!loading && visibleRuns.length === 0 && <p className="panel-empty">{runTaskFilter === 'all' ? '暂无运行记录。' : '该任务暂无运行记录。'}</p>}</div>
      </>}
    {loading && <p className="panel-empty" role="status">正在加载定时任务…</p>}
    {selectedTask && <Modal isOpen onClose={() => setSelectedTask(undefined)} placement="center" scrollBehavior="inside" classNames={{ base: 'app-dialog automation-detail', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop', closeButton: 'app-dialog-close' }} aria-label="自动化详情">
      <ModalContent>
        <ModalHeader className="app-dialog-header automation-detail-header">
          <span className="automation-detail-icon"><AlarmClock size={20} aria-hidden="true" /></span>
          <div className="automation-detail-heading"><span>自动化详情</span><h2>{selectedTask.name || selectedTask.id}</h2></div>
          <span className="automation-detail-status" data-enabled={selectedTask.enabled}>{selectedTask.enabled ? '已启用' : '已暂停'}</span>
        </ModalHeader>
        <ModalBody className="app-dialog-body automation-detail-body">
          <section aria-label="执行配置">
            <dl className="automation-detail-meta">
              <div><dt>执行项目</dt><dd>{workspaceName(selectedTask.workspaceHash)}</dd></div>
              <div><dt>执行计划</dt><dd>{scheduleLabel(selectedTask)}</dd></div>
              <div><dt>会话方式</dt><dd>{selectedTask.sessionMode === 'independent' ? '每次新建独立会话' : sessions.find(session => session.workspaceHash === selectedTask.workspaceHash && session.name === selectedTask.sessionName)?.title || selectedTask.sessionName || '未指定会话'}</dd></div>
              <div><dt>累计运行</dt><dd>{selectedTask.runCount ?? selectedTask.runs?.length ?? 0} 次</dd></div>
            </dl>
            <p className="automation-detail-next"><AlarmClock size={14} aria-hidden="true" /><span>{selectedTask.enabled ? `下次执行：${nextLabel(selectedTask)}` : '任务已暂停，启用后将继续按计划执行。'}</span></p>
          </section>
        </ModalBody>
        <ModalFooter className="app-dialog-footer automation-detail-footer">
          <Button size="sm" color="danger" variant="light" className="automation-detail-delete" startContent={<Trash2 size={15} aria-hidden="true" />} onPress={() => { setDeleting(selectedTask); setSelectedTask(undefined); }}>删除</Button>
          <Button size="sm" variant="bordered" startContent={<Pencil size={15} aria-hidden="true" />} onPress={() => edit(selectedTask)}>编辑</Button>
          <Button size="sm" color="primary" startContent={<Play size={15} aria-hidden="true" />} isDisabled={busy} onPress={() => { setSelectedTask(undefined); void act(selectedTask.workspaceHash, `/${encodeURIComponent(selectedTask.id)}/run`); }}>立即运行</Button>
        </ModalFooter>
      </ModalContent>
    </Modal>}
    {draft && <Modal isOpen onClose={() => { if (!busy) { setDraft(undefined); setError(''); } }} isDismissable={!busy} isKeyboardDismissDisabled={busy} placement="center" scrollBehavior="inside" classNames={{ base: 'app-dialog automation-dialog', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop', closeButton: 'app-dialog-close' }} aria-label={draft.id ? '编辑自动化' : '新建自动化'}>
      <ModalContent><ModalHeader className="automation-dialog-heading"><h2>{draft.id ? '编辑自动化' : '新建自动化'}</h2></ModalHeader>
        <ModalBody className="automation-dialog-body"><div className="automation-editor"><Input aria-label="自动化任务名称" placeholder="自动化任务名称" value={draft.name || ''} onValueChange={value => setDraft({ ...draft, name: value })} variant="flat" className="automation-name" />
          <Textarea aria-label="自动化工作内容" placeholder={'# 目标\n你希望定期完成什么？\n\n# 上下文\n这项工作面向谁？有哪些约束？\n\n# 步骤\n1. ...\n2. ...'} value={draft.message || ''} onValueChange={value => setDraft({ ...draft, message: value })} disableAutosize variant="flat" className="automation-message" />
        </div><div className="automation-settings" ref={settingsRef}>
          {error && <p role="alert" className="settings-error automation-dialog-error">{error}</p>}
          <section><SelectField label="执行项目" value={draftWorkspace} onChange={value => { setDraftWorkspace(value); setDraft({ ...draft, sessionName: '' }); }} disabled={!!draft.id} options={workspaces.map(item => ({ value: item.hash, label: item.displayName || item.name }))} /><RadioGroup aria-label="会话方式" value={draft.sessionMode || 'existing'} onValueChange={value => setDraft({ ...draft, sessionMode: value as 'independent' | 'existing', sessionName: value === 'independent' ? '' : sessionOptions[0]?.value || '' })} size="sm" className="automation-session-mode"><Radio value="independent">每次新建独立会话</Radio><Radio value="existing">使用已有会话</Radio></RadioGroup>{draft.sessionMode !== 'independent' && <><SelectField label="目标会话" required value={draft.sessionName || ''} onChange={value => setDraft({ ...draft, sessionName: value })} options={sessionOptions} />{!sessionOptions.length && <p className="automation-hint">请先在该项目中创建会话。</p>}</>}</section>
          <section><h3>计划时间</h3><div className="automation-schedule-fields"><SelectField label="重复方式" value={mode} onChange={value => setMode(value as ScheduleMode)} options={[{ value: 'daily', label: '每天' }, { value: 'interval', label: '固定间隔' }, { value: 'cron', label: 'Cron 表达式' }]} />
            {mode === 'daily' ? <Field label="执行时间" type="time" required value={time} onChange={setTime} /> : mode === 'interval' ? <Field label="间隔（秒）" required type="number" min={60} value={draft.intervalSec ?? 3600} onChange={value => setDraft({ ...draft, intervalSec: Number(value) })} /> : <Field label="Cron 表达式" required placeholder="0 0 9 * * ?" value={draft.cronExpr || ''} onChange={value => setDraft({ ...draft, cronExpr: value })} />}
            </div><p className="automation-hint">按服务端系统时区执行</p></section>
          <section className="automation-enable"><h3>保存后启用</h3><Switch size="sm" aria-label="保存后启用" isSelected={!!draft.enabled} onValueChange={value => setDraft({ ...draft, enabled: value })} /></section>
        </div></ModalBody>
        <ModalFooter className="app-dialog-footer"><Button variant="light" onPress={() => { setDraft(undefined); setError(''); }} isDisabled={busy}>取消</Button><Button color="primary" isLoading={busy} onPress={save}>{draft.id ? '保存' : '创建'}</Button></ModalFooter>
      </ModalContent>
    </Modal>}
    {selectedRun && <Modal isOpen onClose={() => setSelectedRun(undefined)} placement="center" scrollBehavior="inside" classNames={{ base: 'app-dialog', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop' }} aria-label="执行记录"><ModalContent><ModalHeader className="app-dialog-header">执行记录</ModalHeader><ModalBody className="app-dialog-body"><p>{new Date(selectedRun.run.startedAt).toLocaleString()} · {selectedRun.run.status === 'error' ? '执行失败' : '执行完成'}</p><strong>执行内容</strong><pre className="automation-result">{selectedRun.run.message || '暂无内容'}</pre><strong>{selectedRun.run.status === 'error' ? '错误信息' : '执行结果'}</strong><pre className="automation-result">{selectedRun.run.error || selectedRun.run.result || '暂无输出'}</pre></ModalBody><ModalFooter className="app-dialog-footer">{selectedRun.run.sessionName && <Button color="primary" variant="flat" onPress={() => onOpenSession(selectedRun.task.workspaceHash, selectedRun.run.sessionName!)}>打开会话</Button>}<Button variant="light" onPress={() => setSelectedRun(undefined)}>关闭</Button></ModalFooter></ModalContent></Modal>}
    {deleting && <ConfirmAction title="删除自动化" onClose={() => setDeleting(undefined)} action={() => api.request(`/schedules/${encodeURIComponent(deleting.id)}?${query({ workspaceHash: deleting.workspaceHash })}`, 'DELETE')} onDone={refresh}><p>删除 {deleting.name} 及其执行记录？</p></ConfirmAction>}
  </>;
}
