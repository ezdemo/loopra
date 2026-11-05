import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@nextui-org/react';
import type { LoopraClient, Workspace } from '../backend';
import type { Session } from '../lib';
import { SelectField } from './SettingControls';

type Maintenance = 'clear-all' | 'delete';
type MaintenanceResult = Maintenance | 'clear-old';
type CleanupPeriod = 3 | 7 | 30;
type CleanupScope = `${CleanupPeriod}` | 'all';
type BusyOperation = Maintenance | `clear:${CleanupPeriod}` | 'rename' | '';

type CleanupResult = {
  sessionNames?: string[];
};

const DAY_MS = 24 * 60 * 60 * 1000;
const CLEANUP_SCOPES: { value: CleanupScope; days?: CleanupPeriod; label: string }[] = [
  { value: '3', days: 3, label: '3 天前' },
  { value: '7', days: 7, label: '7 天前' },
  { value: '30', days: 30, label: '1 个月前' },
  { value: 'all', label: '全部会话' },
];

// Clear sessions by age or all at once, or drop the project record from Loopra.
export default function ProjectSessions({ api, workspace, workspaces = [], count, sessions, onClose, onRefresh, onCompleted, onRenamed, onUpdated, notify }: { api: LoopraClient; workspace: Workspace; workspaces?: Workspace[]; count: number; sessions?: Session[]; onClose: () => void; onRefresh: () => Promise<void>; onCompleted: (kind: MaintenanceResult, sessionNames?: string[]) => void; onRenamed?: (previous: Workspace, renamed: Workspace) => void; onUpdated?: (hash: string, linkedProjectHashes: string[]) => void; notify: (message: string) => void }) {
  const [project, setProject] = useState(workspace);
  const chat = workspace.kind === 'chat';
  const title = chat ? '管理纯聊天会话' : '管理项目会话';
  const [displayName, setDisplayName] = useState(workspace.displayName ?? workspace.name);
  const [linkedHashes, setLinkedHashes] = useState(workspace.linkedProjectHashes ?? []);
  const [savingLinks, setSavingLinks] = useState(false);
  const desiredLinks = useRef(linkedHashes);
  const confirmedLinks = useRef(linkedHashes);
  const linkWorker = useRef(false);
  const linkVersion = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [cleanupScope, setCleanupScope] = useState<CleanupScope>('3');
  const [busy, setBusy] = useState<BusyOperation>('');
  const [error, setError] = useState('');
  const locked = useRef(false);
  const candidates = workspaces.filter(item => item.hash !== workspace.hash && item.kind !== 'chat');
  const missingLinks = linkedHashes.filter(hash => !candidates.some(item => item.hash === hash));
  function toggleLinkedProject(hash: string) {
    if (locked.current) return;
    const current = desiredLinks.current;
    const next = current.includes(hash) ? current.filter(value => value !== hash) : [...current, hash];
    if (next.length > 8) return;
    desiredLinks.current = next; linkVersion.current++;
    setLinkedHashes(next); setError('');
    void saveLinkedProjects();
  }
  const selectedScope = CLEANUP_SCOPES.find(scope => scope.value === cleanupScope) ?? CLEANUP_SCOPES[0];
  const cleanupCount = selectedScope.days === undefined
    ? count
    : (sessions ?? []).filter(session => session.mtime !== undefined && session.mtime < Date.now() - selectedScope.days! * DAY_MS).length;
  async function run(kind: Maintenance, label: string, task: () => Promise<unknown>, message: string) {
    if (locked.current) return;
    locked.current = true;
    setBusy(kind); setError('');
    try { await task(); await onRefresh(); onCompleted(kind); notify(message); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : `${label}失败`); }
    finally { locked.current = false; setBusy(''); }
  }
  async function clearSelectedSessions() {
    if (selectedScope.days === undefined) {
      await run('clear-all', '清空', () => api.request(`/sessions?workspaceHash=${encodeURIComponent(project.hash)}`, 'DELETE'), '会话已清空');
      return;
    }
    await clearOlderSessions(selectedScope.days, selectedScope.label);
  }
  async function clearOlderSessions(days: CleanupPeriod, label: string) {
    if (locked.current) return;
    const kind = `clear:${days}` as const;
    locked.current = true;
    setBusy(kind);
    setError('');
    let result: CleanupResult | undefined;
    try {
      const before = Date.now() - days * DAY_MS;
      result = await api.request<CleanupResult>(
        `/sessions/cleanup?workspaceHash=${encodeURIComponent(project.hash)}&before=${before}`,
        'DELETE',
      );
      const sessionNames = result?.sessionNames ?? [];
      onCompleted('clear-old', sessionNames);
      await onRefresh();
      notify(sessionNames.length
        ? `已清理 ${sessionNames.length} 个超过 ${days} 天的会话`
        : `没有超过 ${days} 天的会话需要清理`);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : `清理${label}会话失败`;
      setError(result ? `会话已清理，但刷新列表失败：${detail}` : detail);
      if (result) {
        const deleted = result.sessionNames?.length ?? 0;
        notify(deleted ? `已清理 ${deleted} 个超过 ${days} 天的会话` : `没有超过 ${days} 天的会话需要清理`);
      }
    } finally {
      locked.current = false;
      setBusy('');
    }
  }
  async function renameProject() {
    if (locked.current) return;
    locked.current = true; setBusy('rename'); setError('');
    let saved = false;
    try {
      const renamed = await api.request<Workspace>(`/workspaces/${encodeURIComponent(project.hash)}/name`, 'PUT', { displayName: displayName.trim() });
      setProject(renamed); setDisplayName(renamed.displayName ?? renamed.name);
      onRenamed?.(project, renamed); saved = true;
      notify('项目展示名称已保存'); await onRefresh();
    } catch (cause) {
      setError(`${saved ? '名称已保存，刷新项目失败：' : ''}${cause instanceof Error ? cause.message : '保存名称失败'}`);
    } finally { locked.current = false; setBusy(''); }
  }
  async function saveLinkedProjects() {
    if (linkWorker.current) return;
    linkWorker.current = true; setSavingLinks(true);
    const sameLinks = (a: string[], b: string[]) => a.length === b.length && a.every((hash, index) => hash === b[index]);
    let saved = false, failed = false;
    // 每个弹窗只保留一个请求在途；后续勾选合并成最新快照，关闭后继续提交。
    while (!sameLinks(desiredLinks.current, confirmedLinks.current)) {
      const next = [...desiredLinks.current];
      try {
        const updated = await api.request<Workspace>(`/workspaces/${encodeURIComponent(workspace.hash)}/links`, 'PUT', { linkedProjectHashes: next });
        confirmedLinks.current = updated.linkedProjectHashes ?? [];
        saved = true;
        if (sameLinks(desiredLinks.current, next)) {
          desiredLinks.current = confirmedLinks.current;
          if (mounted.current) setLinkedHashes(confirmedLinks.current);
        }
      } catch (cause) {
        if (!sameLinks(desiredLinks.current, next)) continue;
        desiredLinks.current = confirmedLinks.current; failed = true;
        const detail = cause instanceof Error ? cause.message : '保存关联失败';
        if (mounted.current) { setLinkedHashes(confirmedLinks.current); setError(detail); }
        else notify(`关联副项目保存失败：${detail}`);
      }
    }
    linkWorker.current = false;
    if (mounted.current) {
      setSavingLinks(false);
      setProject(previous => ({ ...previous, linkedProjectHashes: confirmedLinks.current }));
      if (saved) onUpdated?.(workspace.hash, confirmedLinks.current);
    }
    if (!saved) return;
    if (!failed) notify('关联副项目已保存，将在下一轮生效');
    const version = linkVersion.current;
    try { await onRefresh(); }
    catch (cause) {
      if (mounted.current && linkVersion.current === version) setError(`关联已保存，刷新项目失败：${cause instanceof Error ? cause.message : '刷新失败'}`);
    }
  }
  return <Modal isOpen onClose={() => { if (!busy) onClose(); }} isDismissable={!busy} isKeyboardDismissDisabled={!!busy} placement="center" scrollBehavior="inside" classNames={{ base: 'app-dialog project-sessions-dialog', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop', closeButton: 'app-dialog-close' }} aria-label={title}><ModalContent>
    <ModalHeader className="app-dialog-header"><h2>{title}</h2></ModalHeader>
    <ModalBody className="app-dialog-body">
      <div className="project-dialog-summary"><div><strong>{project.name}</strong><span>{count} 个会话</span></div>{project.path && <p>{project.path}</p>}</div>
      {!chat && <form className="project-dialog-rename" onSubmit={event => { event.preventDefault(); void renameProject(); }}>
        <label htmlFor="project-session-display-name">项目展示名称</label>
        <div><input id="project-session-display-name" value={displayName} maxLength={80} disabled={!!busy} onChange={event => setDisplayName(event.target.value)} autoComplete="off" placeholder="留空恢复文件夹名称" /><Button type="submit" size="sm" color="primary" isLoading={busy === 'rename'} isDisabled={!!busy || displayName.trim() === (project.displayName ?? project.name)}>保存名称</Button></div>
        <p>最多 80 个字符，留空恢复文件夹名称。</p>
      </form>}
      {!chat && <section className="project-dialog-links" aria-label="关联副项目">
        <div className="project-dialog-links-heading"><h3>关联副项目</h3><span>{linkedHashes.length} / 8</span></div>
        <p>勾选后自动保存，从下一轮生效。</p>
        <div className="project-dialog-links-list" aria-busy={savingLinks}>
          {candidates.map(item => <Checkbox key={item.hash} size="sm" classNames={{ base: 'project-dialog-link', label: 'project-dialog-link-info' }} isSelected={linkedHashes.includes(item.hash)} isDisabled={!!busy || (!linkedHashes.includes(item.hash) && linkedHashes.length >= 8)} onValueChange={() => toggleLinkedProject(item.hash)}>
            <strong>{item.name}</strong><small>{item.path}</small>
          </Checkbox>)}
          {missingLinks.map(hash => <Checkbox key={hash} size="sm" classNames={{ base: 'project-dialog-link', label: 'project-dialog-link-info' }} isSelected isDisabled={!!busy} onValueChange={() => toggleLinkedProject(hash)}><strong>项目已移除</strong><small>{hash} · 取消勾选以解除关联</small></Checkbox>)}
          {!candidates.length && !missingLinks.length && <p>暂无其他项目，请先在项目列表中添加副项目。</p>}
        </div>
      </section>}
      <div className="project-dialog-operations">
        <div className="project-dialog-operation project-dialog-cleanup">
          <div><h3>清理会话</h3><p>{chat ? '按最后活动时间清理，也可以删除全部会话。' : '按最后活动时间清理，也可以删除全部会话；项目记录会保留。'}</p></div>
          <div className="project-dialog-cleanup-controls">
            <div className="project-dialog-cleanup-select"><SelectField label="清理范围" value={cleanupScope} onChange={value => setCleanupScope(value as CleanupScope)} options={CLEANUP_SCOPES.map(scope => ({ value: scope.value, label: scope.label }))} disabled={!!busy} /></div>
            <Button size="sm" color="danger" variant="flat" isLoading={busy === 'clear-all' || busy.startsWith('clear:')} isDisabled={!!busy || cleanupCount === 0} onPress={() => void clearSelectedSessions()}>清理会话</Button>
          </div>
          <p className="project-dialog-cleanup-preview">{selectedScope.days === undefined ? `将删除全部 ${count} 个会话` : `将删除 ${cleanupCount} 个超过 ${selectedScope.days} 天未活动的会话`}，此操作不可恢复。</p>
        </div>
        {!chat && <div className="project-dialog-operation"><div><h3>删除项目</h3><p>移除项目及其会话，磁盘上的文件不受影响。</p></div><Button size="sm" color="danger" variant="flat" isLoading={busy === 'delete'} isDisabled={!!busy} onPress={() => void run('delete', '删除', () => api.request(`/workspaces/${encodeURIComponent(workspace.hash)}`, 'DELETE'), '项目已删除')}>删除项目</Button></div>}
      </div>
      {error && <p role="alert" className="settings-error">{error}</p>}
    </ModalBody>
    <ModalFooter className="app-dialog-footer"><Button size="sm" variant="light" isDisabled={!!busy} onPress={onClose}>关闭</Button></ModalFooter>
  </ModalContent></Modal>;
}
