import { useEffect, useMemo, useState } from 'react';
import { Button, Modal, ModalContent } from '@nextui-org/react';
import { Activity, Clock, Download, MessageCircle, Plus, RefreshCw, Trash2, Wrench } from 'lucide-react';
import type { LoopraClient } from '../backend';
import { query, ConfirmAction } from './RemoteControls';
import { formatSessionTime, formatTokenUsage, filterSessions, paginate, sessionExportPayload, sessionMetrics, type ManagedSession } from '../session-stats';
import { usagePath, type UsageDTO } from '../usage';

const PAGE_SIZE = 10;

// Ported from legacy `src/views/Sessions.vue`: summary cards, searchable session
// list with paging, per-session load/export/delete and a scoped bulk clear.
export default function SessionsManager({ api, sessions, workspaceHash, workspaceName, activeId, onClose, onOpen, onNew, onChanged, notify }: {
  api: LoopraClient; sessions: ManagedSession[]; workspaceHash: string; workspaceName: string; activeId: string | null;
  onClose: () => void; onOpen: (id: string) => void; onNew: () => void; onChanged: () => Promise<void>; notify: (message: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [pendingDelete, setPendingDelete] = useState<ManagedSession>();
  const [clearOpen, setClearOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [batchOpen, setBatchOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const [usage, setUsage] = useState<UsageDTO>();

  useEffect(() => {
    if (!workspaceHash) { setUsage(undefined); return; }
    const controller = new AbortController();
    void api.request<UsageDTO>(usagePath(workspaceHash), 'GET', undefined, controller.signal)
      .then(data => { if (!controller.signal.aborted) setUsage(data); })
      .catch(() => { if (!controller.signal.aborted) setUsage(undefined); });
    return () => controller.abort();
  }, [api, workspaceHash, revision]);

  const filtered = useMemo(() => filterSessions(sessions, search), [sessions, search]);
  const paged = paginate(filtered, page, PAGE_SIZE);
  const metrics = sessionMetrics(filtered);
  const totalTokens = usage?.totalTokens || 0;
  // Legacy DesktopHome multi-select keeps only ids that still exist after a refresh.
  const selectedSessions = sessions.filter(item => selected.includes(item.id));

  async function refresh() {
    setBusy('refresh'); setError('');
    try { await onChanged(); setRevision(value => value + 1); notify('会话列表已刷新'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '刷新失败'); }
    finally { setBusy(''); }
  }

  async function remove(target: ManagedSession) {
    const path = `/sessions/${encodeURIComponent(target.name || '')}?${query({ workspaceHash: target.workspaceHash || workspaceHash })}`;
    await api.request(path, 'DELETE');
    await onChanged();
    notify(`会话 ${target.title} 已删除`);
  }

  async function clearWorkspace() {
    await api.request(`/sessions?${query({ workspaceHash })}`, 'DELETE');
    await onChanged();
    notify('当前工作区会话已清空');
  }

  // Legacy `DesktopShell.performDeleteSessions`: delete one by one, keep the
  // successful ones and report a mixed result instead of aborting the batch.
  async function removeSelected() {
    const deleted: string[] = []; const failed: string[] = [];
    for (const target of selectedSessions) {
      try {
        await api.request(`/sessions/${encodeURIComponent(target.name || '')}?${query({ workspaceHash: target.workspaceHash || workspaceHash })}`, 'DELETE');
        deleted.push(target.id);
      } catch { failed.push(target.title || target.name || target.id); }
    }
    setSelected(deleted.length ? current => current.filter(id => !deleted.includes(id)) : []);
    await onChanged();
    if (deleted.length && !failed.length) notify(`已删除 ${deleted.length} 个会话`);
    else if (deleted.length) notify(`已删除 ${deleted.length} 个会话，${failed.length} 个失败：${failed.join('、')}`);
    else throw new Error(`删除失败：${failed.join('、')}`);
  }

  function toggleSelected(id: string) {
    setSelected(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  }

  function download(target: ManagedSession) {
    const blob = new Blob([sessionExportPayload(target)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `loopra-session-${target.name || target.id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    notify(`会话 ${target.title} 已导出`);
  }

  return <Modal isOpen onClose={onClose} placement="center" backdrop="opaque" hideCloseButton classNames={{ wrapper: 'settings-wrapper', base: 'settings-modal sessions-manager' }} aria-label="会话管理">
    <ModalContent><div className="sessions-manager-body">
      <header className="sessions-manager-head">
        <div><h2>会话管理</h2><p>{sessions.length} 个会话 · {workspaceName || '全部工作区'}</p></div>
        <div className="sessions-manager-actions">
          <Button size="sm" variant="flat" isDisabled={!!busy || !sessions.length} onPress={() => setSelected(selected.length === sessions.length ? [] : sessions.map(item => item.id))}>{selected.length === sessions.length && sessions.length ? '取消全选' : '全选'}</Button>
          <Button size="sm" color="danger" variant="flat" isDisabled={!!busy || !selected.length} onPress={() => setBatchOpen(true)}><Trash2 size="0.875rem" />删除选中 ({selected.length})</Button>
          <Button size="sm" variant="flat" isDisabled={!!busy} onPress={() => void refresh()}><RefreshCw size="0.875rem" />刷新</Button>
          <Button size="sm" color="danger" variant="flat" isDisabled={!!busy || !workspaceHash || !sessions.length} onPress={() => setClearOpen(true)}><Trash2 size="0.875rem" />清空当前工作区</Button>
          <Button size="sm" color="primary" isDisabled={!!busy} onPress={onNew}><Plus size="0.875rem" />新建会话</Button>
          <Button size="sm" variant="light" isDisabled={!!busy} onPress={onClose}>关闭</Button>
        </div>
      </header>

      {error && <p className="settings-error" role="alert">{error}</p>}

      <div className="sessions-manager-stats">
        {([['总消息数', metrics.totalMessages, MessageCircle], ['工具调用', metrics.totalToolCalls, Wrench], ['平均时长', metrics.averageSessionLength, Clock], ['总 Token', formatTokenUsage(totalTokens), Activity]] as const)
          .map(([label, value, Icon]) => <div className="settings-metric" key={label}><span><Icon size="0.875rem" />{label}</span><strong>{typeof value === 'number' ? value.toLocaleString() : value}</strong></div>)}
      </div>

      <label className="sessions-manager-search"><input aria-label="搜索会话" placeholder="搜索会话标题或工作区…" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} /></label>

      {!filtered.length ? <p className="panel-empty">{sessions.length ? '没有匹配的会话' : '暂无会话，创建您的第一个会话开始使用。'}</p> : <div className="sessions-manager-list">
        {paged.items.map(session => <article key={session.id} className={`sessions-manager-card ${activeId === session.id ? 'active' : ''} ${selected.includes(session.id) ? 'selected' : ''}`}>
          <label className="sessions-manager-check"><input type="checkbox" aria-label={`选择会话：${session.title}`} checked={selected.includes(session.id)} onChange={() => toggleSelected(session.id)} /></label>
          <div className="sessions-manager-card-main">
            <h3>{session.title}{session.worktreeMode && <span className="wt-badge" title="隔离分支模式">🌲</span>}</h3>
            <p>#{session.name || session.id} · {session.workspace || workspaceName}</p>
            <dl>
              <div><dt>最后活动</dt><dd>{formatSessionTime(session.mtime)}</dd></div>
              <div><dt>消息数</dt><dd>{session.messageCount ?? '—'}</dd></div>
            </dl>
          </div>
          <div className="sessions-manager-card-actions">
            <Button size="sm" variant="flat" isDisabled={!!busy} onPress={() => onOpen(session.id)}>加载</Button>
            <Button size="sm" variant="light" isDisabled={!!busy} onPress={() => download(session)}><Download size="0.875rem" />导出</Button>
            <Button size="sm" color="danger" variant="light" isDisabled={!!busy} onPress={() => setPendingDelete(session)}><Trash2 size="0.875rem" />删除</Button>
          </div>
        </article>)}
      </div>}

      {paged.totalPages > 1 && <footer className="sessions-manager-paging">
        <Button size="sm" variant="light" isDisabled={paged.page === 1} onPress={() => setPage(paged.page - 1)}>上一页</Button>
        <span>第 {paged.page} 页，共 {paged.totalPages} 页</span>
        <Button size="sm" variant="light" isDisabled={paged.page === paged.totalPages} onPress={() => setPage(paged.page + 1)}>下一页</Button>
      </footer>}

      {pendingDelete && <ConfirmAction title="删除会话" onClose={() => setPendingDelete(undefined)} action={() => remove(pendingDelete)} onDone={() => setPendingDelete(undefined)}>
        <p>删除 {pendingDelete.title} 及其在 Loopra 服务端的记录？此操作不可恢复。</p>
      </ConfirmAction>}
      {clearOpen && <ConfirmAction title="清空当前工作区会话" onClose={() => setClearOpen(false)} action={clearWorkspace} onDone={() => setClearOpen(false)}>
        <p>清空“{workspaceName || workspaceHash}”的全部会话记录？此操作不可恢复。</p>
      </ConfirmAction>}
      {batchOpen && <ConfirmAction title="删除选中的会话" onClose={() => setBatchOpen(false)} action={removeSelected} onDone={() => setBatchOpen(false)}>
        <p>{selectedSessions.length > 3 ? `选中的 ${selectedSessions.length} 个会话（${selectedSessions.slice(0, 3).map(item => item.title).join('、')} 等）` : selectedSessions.map(item => item.title).join('、')}将被永久删除，无法恢复。</p>
      </ConfirmAction>}
    </div></ModalContent>
  </Modal>;
}
