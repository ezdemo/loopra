import { TextField, Field, SelectField } from './SettingControls';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Modal, ModalContent, Radio, RadioGroup, Spinner } from '@nextui-org/react';
import { ArrowLeft, Bot, Calendar, Clock, Plus, RefreshCw, Send, Trash2, X } from 'lucide-react';
import type { LoopraClient } from '../backend';
import type { HistoryMessage } from '../backend';
import type { Workspace } from '../backend';
import Markdown from './Markdown';
import BlockRenderer from './BlockRenderer';
import {
  REQUIREMENT_COLUMNS, REQUIREMENT_EFFORT_OPTIONS, REQUIREMENT_HITL_OPTIONS, REQUIREMENT_PRIORITY_OPTIONS,
  formatRequirementRelative, formatRequirementTime, isScheduledRequirement, normalizeRequirementComment,
  requirementCommentCount, requirementComments, requirementLogCount, requirementLogMessages,
  requirementModelOptions, requirementPriorityLabel, requirementScheduleDescription, requirementScheduleMin,
  requirementStatusLabel, splitRequirementModel, type Requirement, type RequirementChannel,
} from '../requirements';

const POLL_INTERVAL = 3000;

type RequirementConfig = { model?: string; modelChannelId?: string; reasoningEffort?: string; hitl?: string; modelChannels?: RequirementChannel[] };

/**
 * Ported from legacy `src/views/RequirementBoard.vue`: four-column board, a
 * full-screen detail view with comment / execution-log tabs, AI run / abort /
 * approval actions and the create dialog. The backend `RequirementStore` stays
 * authoritative, so the view polls every 3s instead of mutating local state.
 */
export default function RequirementBoard({ api, onClose, notify }: { api: LoopraClient; onClose: () => void; notify: (message: string) => void }) {
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<HistoryMessage[]>([]);
  const [detailTab, setDetailTab] = useState<'comments' | 'logs'>('comments');
  const [commentDraft, setCommentDraft] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [config, setConfig] = useState<RequirementConfig>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [draft, setDraft] = useState({
    title: '', description: '', priority: 'medium', projectHash: '', modelSelection: '',
    reasoningEffort: 'max', hitl: 'free', scheduleMode: 'immediate', scheduledAt: '',
  });
  const listRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const selected = requirements.find(item => item.id === selectedId);
  const comments = useMemo(() => requirementComments(messages), [messages]);
  const logs = useMemo(() => requirementLogMessages(messages), [messages]);
  const modelOptions = useMemo(() => requirementModelOptions(config?.modelChannels), [config]);

  async function loadRequirements() {
    setLoading(true);
    try { setRequirements(await api.request<Requirement[]>('/requirements', 'GET')); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '加载需求失败'); }
    finally { setLoading(false); }
  }

  async function loadMessages(id: string) {
    try { setMessages(await api.request<HistoryMessage[]>(`/requirements/${encodeURIComponent(id)}/messages`, 'GET')); }
    catch { setMessages([]); }
  }

  async function act(label: string, run: () => Promise<unknown>, after?: () => void) {
    setBusy(label); setError('');
    try { await run(); after?.(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '操作失败'); }
    finally { setBusy(''); }
  }

  // Board refresh always; the message stream only while a detail view is open.
  useEffect(() => {
    void loadRequirements();
    const timer = setInterval(() => {
      void loadRequirements();
      if (selectedId) void loadMessages(selectedId);
    }, POLL_INTERVAL);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, selectedId]);

  useEffect(() => {
    void Promise.allSettled([
      api.request<Workspace[]>('/workspaces', 'GET').then(setWorkspaces),
      api.request<RequirementConfig>('/config', 'GET').then(setConfig),
    ]);
  }, [api]);

  useEffect(() => {
    if (!followRef.current) return;
    const element = listRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages, detailTab]);

  useEffect(() => {
    if (!deleteArmed) return;
    const timer = setTimeout(() => setDeleteArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [deleteArmed]);

  function openDetail(item: Requirement) {
    setSelectedId(item.id);
    setDetailTab('comments');
    setCommentDraft('');
    setMessages([]);
    followRef.current = true;
    void loadMessages(item.id);
  }

  function closeDetail() {
    setSelectedId(null);
    setMessages([]);
    setCommentDraft('');
    setDeleteArmed(false);
  }

  function openCreate() {
    setDraft({
      title: '', description: '', priority: 'medium', projectHash: '',
      modelSelection: config?.modelChannelId && config?.model ? `${config.modelChannelId}::${config.model}` : '',
      reasoningEffort: config?.reasoningEffort || 'max',
      hitl: config?.hitl || 'free',
      scheduleMode: 'immediate', scheduledAt: '',
    });
    setError('');
    setCreateOpen(true);
  }

  async function createRequirement() {
    const title = draft.title.trim();
    const project = workspaces.find(item => item.hash === draft.projectHash);
    if (!title || !project) return;
    const scheduledAt = draft.scheduleMode === 'scheduled' ? new Date(draft.scheduledAt).getTime() : 0;
    if (draft.scheduleMode === 'scheduled' && (!Number.isFinite(scheduledAt) || scheduledAt <= Date.now())) { setError('执行时间必须晚于当前时间'); return; }
    const { model, modelChannelId } = splitRequirementModel(draft.modelSelection);
    await act('create', async () => {
      const created = await api.request<Requirement>('/requirements', 'POST', {
        title, description: draft.description.trim(), priority: draft.priority,
        projectHash: project.hash, projectName: project.name,
        model, modelChannelId,
        reasoningEffort: draft.reasoningEffort, hitl: draft.hitl,
        scheduleMode: draft.scheduleMode, scheduledAt,
      });
      // Immediate requirements enter the queue right away (legacy creates then runs).
      if (draft.scheduleMode === 'immediate') await api.request(`/requirements/${encodeURIComponent(created.id)}/run`, 'POST');
      setCreateOpen(false);
      notify('需求已创建');
      await loadRequirements();
    });
  }

  async function sendComment() {
    const text = commentDraft.trim();
    if (!text || !selected) return;
    await act('comment', async () => {
      await api.request(`/requirements/${encodeURIComponent(selected.id)}/comments`, 'POST', { text });
      setCommentDraft('');
      await loadMessages(selected.id);
    });
  }

  function requestDelete() {
    if (!selected) return;
    if (!deleteArmed) { setDeleteArmed(true); return; }
    void act('delete', async () => {
      await api.request(`/requirements/${encodeURIComponent(selected.id)}`, 'DELETE');
      closeDetail();
      await loadRequirements();
    });
  }

  function onScroll(event: React.UIEvent<HTMLDivElement>) {
    const element = event.currentTarget;
    followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 40;
  }

  const detailBusy = !!busy;

  return <Modal isOpen onClose={() => { if (!busy) onClose(); }} size="full" hideCloseButton backdrop="opaque" classNames={{ base: 'requirement-board', wrapper: 'requirement-board-wrapper' }} aria-label="需求池">
    <ModalContent>
      {selected ? <div className="req-detail">
        <header className="req-detail-topbar">
          <button type="button" className="req-back" onClick={closeDetail}><ArrowLeft size="0.9375rem" />需求池</button>
          <div className="req-detail-title">
            <span className={`req-status req-status-${selected.status || 'todo'}`}>{requirementStatusLabel(selected.status)}</span>
            <span className={`req-priority req-priority-${selected.priority || 'medium'}`}>{requirementPriorityLabel(selected.priority)}优先级</span>
            <span className="req-detail-id">#{selected.id.slice(-4)}</span>
            <strong title={selected.title}>{selected.title}</strong>
          </div>
          <div className="req-detail-actions">
            {deleteArmed && <Button size="sm" color="danger" isDisabled={detailBusy} onPress={requestDelete}><Trash2 size="0.875rem" />确认删除</Button>}
            {!deleteArmed && <Button isIconOnly size="sm" variant="light" aria-label="删除需求" isDisabled={detailBusy} onPress={requestDelete}><Trash2 size="0.9375rem" /></Button>}
            <Button isIconOnly size="sm" variant="light" aria-label="关闭需求详情" onPress={closeDetail}><X size="0.9375rem" /></Button>
          </div>
        </header>
        <div className="req-detail-main">
          <section className="req-detail-info">
            <div className="req-info-card">
              <h3>描述{selected.projectName && <span className="req-info-project">项目：{selected.projectName}</span>}</h3>
              <p className="req-detail-desc">{selected.description || '暂无描述'}</p>
            </div>
            <div className="req-info-card">
              <h3>AI 执行</h3>
              <div className="req-ai-box">
                <span className="req-ai-icon"><Bot size="1.0625rem" /></span>
                <div className="req-ai-info"><strong>{selected.approvalPending ? '等待审批' : requirementStatusLabel(selected.status)}</strong><small>{requirementScheduleDescription(selected)}</small></div>
                <div className="req-ai-actions">
                  {selected.status === 'doing' && selected.approvalPending ? <>
                    <Button size="sm" color="primary" isLoading={busy === 'approve'} isDisabled={detailBusy} onPress={() => void act('approve', () => api.request(`/requirements/${encodeURIComponent(selected.id)}/approval`, 'POST', { action: 'approve' }), () => { void loadRequirements(); void loadMessages(selected.id); })}>同意执行</Button>
                    <Button size="sm" color="danger" variant="flat" isDisabled={detailBusy} onPress={() => void act('deny', () => api.request(`/requirements/${encodeURIComponent(selected.id)}/approval`, 'POST', { action: 'deny' }), () => { void loadRequirements(); void loadMessages(selected.id); })}>拒绝执行</Button>
                  </> : selected.status === 'doing'
                    ? <Button size="sm" color="danger" variant="flat" isLoading={busy === 'abort'} isDisabled={detailBusy} onPress={() => void act('abort', () => api.request(`/requirements/${encodeURIComponent(selected.id)}/abort`, 'POST'), () => void loadRequirements())}>取消执行</Button>
                    : <Button size="sm" color="primary" isLoading={busy === 'run'} isDisabled={detailBusy} onPress={() => void act('run', () => api.request(`/requirements/${encodeURIComponent(selected.id)}/run`, 'POST'), () => void loadRequirements())}>{selected.status === 'todo' ? '让 AI 执行' : '重新执行'}</Button>}
                </div>
              </div>
            </div>
          </section>
          <div className="req-detail-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={detailTab === 'comments'} className={detailTab === 'comments' ? 'active' : ''} onClick={() => { setDetailTab('comments'); followRef.current = true; }}>评论 ({requirementCommentCount(messages)})</button>
            <button type="button" role="tab" aria-selected={detailTab === 'logs'} className={detailTab === 'logs' ? 'active' : ''} onClick={() => { setDetailTab('logs'); followRef.current = true; }}>执行日志 ({requirementLogCount(messages)})</button>
          </div>
          {error && <p className="settings-error" role="alert">{error}</p>}
          <div className="req-detail-body" ref={listRef} onScroll={onScroll}>
            {detailTab === 'logs' ? <>
              {logs.map(message => <article key={message.id} className="req-log-message"><BlockRenderer blocks={message.blocks || (message.text ? [{ id: `${message.id}-text`, type: 'content', content: message.text }] : [])} notify={notify} /></article>)}
              {!logs.length && <p className="req-empty">暂无执行日志</p>}
            </> : <>
              {comments.map(item => <article key={item.id} className={`req-comment req-comment-${item.role}`}>
                <header><span className={`req-comment-avatar ${item.role}`}>{item.role === 'assistant' ? <Bot size="0.75rem" /> : '我'}</span><strong>{item.role === 'assistant' ? 'AI 执行 Agent' : '我'}</strong><time>{formatRequirementRelative(item.timestamp)}</time></header>
                <div className="req-comment-text"><Markdown text={normalizeRequirementComment(item.content)} notify={notify} /></div>
              </article>)}
              {!comments.length && <p className="req-empty">暂无评论，来抢沙发～</p>}
            </>}
          </div>
          {detailTab === 'comments' && <form className="req-comment-form" onSubmit={event => { event.preventDefault(); void sendComment(); }}>
            <TextField label={"需求评论"} rows={2} maxLength={500} aria-label={"需求评论"} placeholder={"写下你的评论…（Enter 发送，Shift+Enter 换行）"} value={(commentDraft) ?? ''} onChange={value => setCommentDraft(value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendComment(); } }} />
            <div><Button size="sm" type="submit" color="primary" isDisabled={!commentDraft.trim() || detailBusy}><Send size="0.875rem" />发送评论</Button></div>
          </form>}
        </div>
      </div> : <div className="req-board">
        <header className="req-board-header">
          <div className="req-board-title"><Clock size="1.0625rem" /><strong>需求池</strong><span>{requirements.length} 条需求</span></div>
          <div className="req-board-header-actions">
            <span className="req-board-tip">需求由 AI 自动执行并流转状态</span>
            <Button size="sm" variant="light" isDisabled={loading} onPress={() => void loadRequirements()}><RefreshCw size="0.875rem" />刷新</Button>
            <Button size="sm" color="primary" onPress={openCreate}><Plus size="0.875rem" />新建需求</Button>
            <Button size="sm" variant="light" onPress={onClose}><X size="0.875rem" />关闭</Button>
          </div>
        </header>
        {error && <p className="settings-error" role="alert">{error}</p>}
        <main className="req-board-columns">
          {REQUIREMENT_COLUMNS.map(column => {
            const items = requirements.filter(item => item.status === column.key);
            return <section key={column.key} className="req-column">
              <header><i style={{ background: column.color }} /><strong>{column.label}</strong><span>{items.length}</span>{column.key === 'todo' && <small>AI 待调度</small>}{column.key === 'doing' && <small>AI 执行中</small>}</header>
              <div className="req-column-body">
                {items.map(item => <article key={item.id} className="req-card">
                  <button type="button" onClick={() => openDetail(item)}>
                    <span className="req-card-title">{item.title}<i className={`req-priority req-priority-${item.priority || 'medium'}`}>{requirementPriorityLabel(item.priority)}</i></span>
                    <span className="req-card-meta">
                      {item.projectName && <span className="req-project-badge" title={`项目：${item.projectName}`}>{item.projectName}</span>}
                      <span className="req-ai-badge"><Bot size="0.6875rem" />AI 执行</span>
                      {isScheduledRequirement(item) && <span className="req-schedule-badge" title={requirementScheduleDescription(item)}><Calendar size="0.6875rem" />定时 {formatRequirementTime(item.scheduledAt)}</span>}
                      <time>{formatRequirementTime(item.updatedAt)}</time>
                    </span>
                  </button>
                </article>)}
                {!items.length && <p className="req-column-empty">暂无需求</p>}
              </div>
            </section>;
          })}
        </main>
        {loading && !requirements.length && <div className="req-loading"><Spinner size="sm" aria-label="正在加载需求" /></div>}
      </div>}
    </ModalContent>

    <Modal isOpen={createOpen} onClose={() => { if (!busy) setCreateOpen(false); }} placement="center" hideCloseButton classNames={{ base: 'req-create-modal' }} aria-label="新建需求">
      <ModalContent><form className="req-create" onSubmit={event => { event.preventDefault(); void createRequirement(); }}>
        <header><strong>新建需求</strong><Button isIconOnly size="sm" variant="light" aria-label="关闭新建需求" onPress={() => setCreateOpen(false)}><X size="0.9375rem" /></Button></header>
        <div className="req-create-body">
          <Field label="标题" required={true} maxLength={60} placeholder={"需求标题"} value={(draft.title) ?? ''} onChange={value => setDraft({ ...draft, title: value })} />
          <TextField label={"描述"} rows={4} maxLength={500} placeholder={"需求描述、验收标准…（AI 将根据描述自动执行）"} value={(draft.description) ?? ''} onChange={value => setDraft({ ...draft, description: value })} />
          <SelectField label="项目" required={true} value={String((draft.projectHash) ?? '')} onChange={value => setDraft({ ...draft, projectHash: value })} options={[({ value: String(""), label: "请选择项目" }), ...(workspaces.map(item => ({ value: String(item.hash), label: String(item.name || item.path) })) || [])]} />
          <div className="req-config-row">
            <SelectField label={"优先级"} value={String((draft.priority) ?? '')} onChange={value => setDraft({ ...draft, priority: value })} options={[...(REQUIREMENT_PRIORITY_OPTIONS.map(option => ({ value: String(option.value), label: String(option.label) })) || [])]} />
            <SelectField label={"模型"} value={String((draft.modelSelection) ?? '')} onChange={value => setDraft({ ...draft, modelSelection: value })} options={[({ value: String(""), label: "使用默认模型" }), ...(modelOptions.map(option => ({ value: String(option.value), label: String(option.label) })) || [])]} />
          </div>
          <div className="req-config-row">
            <SelectField label={"推理强度"} value={String((draft.reasoningEffort) ?? '')} onChange={value => setDraft({ ...draft, reasoningEffort: value })} options={[...(REQUIREMENT_EFFORT_OPTIONS.map(option => ({ value: String(option.value), label: String(option.label) })) || [])]} />
            <SelectField label={"审批模式"} value={String((draft.hitl) ?? '')} onChange={value => setDraft({ ...draft, hitl: value })} options={[...(REQUIREMENT_HITL_OPTIONS.map(option => ({ value: String(option.value), label: String(option.label) })) || [])]} />
          </div>
          <RadioGroup label="执行方式" value={draft.scheduleMode} onValueChange={value => setDraft({ ...draft, scheduleMode: value === 'scheduled' ? 'scheduled' : 'immediate', scheduledAt: value === 'scheduled' ? draft.scheduledAt : '' })} className="req-schedule-mode" classNames={{ wrapper: 'req-schedule-options' }}>
            <Radio value="immediate" description="创建后直接进入执行队列">立即执行</Radio>
            <Radio value="scheduled" description="到指定时间后自动执行">定时执行</Radio>
          </RadioGroup>
          {draft.scheduleMode === 'scheduled' && <Field label="执行时间" required={true} type={"datetime-local"} min={requirementScheduleMin()} value={(draft.scheduledAt) ?? ''} onChange={value => setDraft({ ...draft, scheduledAt: value })} />}
          <p className="req-create-tip">立即执行会直接入队；定时执行将在指定时间由 AI 自动启动。</p>
          {error && <p className="settings-error" role="alert">{error}</p>}
        </div>
        <footer><Button size="sm" variant="light" onPress={() => setCreateOpen(false)}>取消</Button><Button size="sm" type="submit" color="primary" isLoading={busy === 'create'} isDisabled={!draft.title.trim() || !draft.projectHash}>创建</Button></footer>
      </form></ModalContent>
    </Modal>
  </Modal>;
}
