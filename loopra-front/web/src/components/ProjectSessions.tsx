import { useRef, useState } from 'react';
import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@nextui-org/react';
import type { LoopraClient, Workspace } from '../backend';
import type { Session } from '../lib';
import { SelectField } from './SettingControls';

type Maintenance = 'refresh' | 'clear-all' | 'delete';
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

// Ported from App.vue's "管理项目会话" dialog: refresh the project's sessions,
// clear sessions by age or all at once, or drop the project record from Loopra.
export default function ProjectSessions({ api, workspace, count, sessions, onClose, onRefresh, onCompleted, onRenamed, notify }: { api: LoopraClient; workspace: Workspace; count: number; sessions?: Session[]; onClose: () => void; onRefresh: () => Promise<void>; onCompleted: (kind: MaintenanceResult, sessionNames?: string[]) => void; onRenamed?: (previous: Workspace, renamed: Workspace) => void; notify: (message: string) => void }) {
  const [project, setProject] = useState(workspace);
  const [displayName, setDisplayName] = useState(workspace.displayName ?? workspace.name);
  const [cleanupScope, setCleanupScope] = useState<CleanupScope>('3');
  const [busy, setBusy] = useState<BusyOperation>('');
  const [error, setError] = useState('');
  const locked = useRef(false);
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
  return <Modal isOpen onClose={() => { if (!busy) onClose(); }} isDismissable={!busy} isKeyboardDismissDisabled={!!busy} placement="center" scrollBehavior="inside" classNames={{ base: 'app-dialog project-sessions-dialog', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop', closeButton: 'app-dialog-close' }} aria-label="管理项目会话"><ModalContent>
    <ModalHeader className="app-dialog-header"><h2>管理项目会话</h2></ModalHeader>
    <ModalBody className="app-dialog-body">
      <div className="project-dialog-summary"><div><strong>{project.name}</strong><span>{count} 个会话</span></div><p>{project.path}</p></div>
      <form className="project-dialog-rename" onSubmit={event => { event.preventDefault(); void renameProject(); }}>
        <label htmlFor="project-session-display-name">项目展示名称</label>
        <div><input id="project-session-display-name" value={displayName} maxLength={80} disabled={!!busy} onChange={event => setDisplayName(event.target.value)} autoComplete="off" placeholder="留空恢复文件夹名称" /><Button type="submit" size="sm" color="primary" isLoading={busy === 'rename'} isDisabled={!!busy || displayName.trim() === (project.displayName ?? project.name)}>保存名称</Button></div>
        <p>最多 80 个字符，留空恢复文件夹名称。</p>
      </form>
      <div className="project-dialog-operations">
        <div className="project-dialog-operation"><div><h3>刷新会话</h3><p>重新获取该项目的会话列表。</p></div><Button size="sm" variant="bordered" isLoading={busy === 'refresh'} isDisabled={!!busy} onPress={() => void run('refresh', '刷新', async () => {}, '会话列表已刷新')}>刷新会话列表</Button></div>
        <div className="project-dialog-operation project-dialog-cleanup">
          <div><h3>清理会话</h3><p>按最后活动时间清理，也可以删除全部会话；项目记录会保留。</p></div>
          <div className="project-dialog-cleanup-controls">
            <div className="project-dialog-cleanup-select"><SelectField label="清理范围" value={cleanupScope} onChange={value => setCleanupScope(value as CleanupScope)} options={CLEANUP_SCOPES.map(scope => ({ value: scope.value, label: scope.label }))} disabled={!!busy} /></div>
            <Button size="sm" color="danger" variant="flat" isLoading={busy === 'clear-all' || busy.startsWith('clear:')} isDisabled={!!busy || cleanupCount === 0} onPress={() => void clearSelectedSessions()}>清理会话</Button>
          </div>
          <p className="project-dialog-cleanup-preview">{selectedScope.days === undefined ? `将删除全部 ${count} 个会话` : `将删除 ${cleanupCount} 个超过 ${selectedScope.days} 天未活动的会话`}，此操作不可恢复。</p>
        </div>
        <div className="project-dialog-operation"><div><h3>删除项目</h3><p>移除项目及其会话，磁盘上的文件不受影响。</p></div><Button size="sm" color="danger" variant="flat" isLoading={busy === 'delete'} isDisabled={!!busy} onPress={() => void run('delete', '删除', () => api.request(`/workspaces/${encodeURIComponent(workspace.hash)}`, 'DELETE'), '项目已删除')}>删除项目</Button></div>
      </div>
      {error && <p role="alert" className="settings-error">{error}</p>}
    </ModalBody>
    <ModalFooter className="app-dialog-footer"><Button size="sm" variant="light" isDisabled={!!busy} onPress={onClose}>取消</Button></ModalFooter>
  </ModalContent></Modal>;
}
