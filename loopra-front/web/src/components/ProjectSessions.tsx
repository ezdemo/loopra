import { useRef, useState } from 'react';
import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@nextui-org/react';
import type { LoopraClient, Workspace } from '../backend';

type Maintenance = 'refresh' | 'clear' | 'delete';

// Ported from App.vue's "管理项目会话" dialog: refresh the project's sessions,
// clear them all, or drop the project record from Loopra.
export default function ProjectSessions({ api, workspace, count, onClose, onRefresh, onCompleted, onRenamed, notify }: { api: LoopraClient; workspace: Workspace; count: number; onClose: () => void; onRefresh: () => Promise<void>; onCompleted: (kind: Maintenance) => void; onRenamed?: (previous: Workspace, renamed: Workspace) => void; notify: (message: string) => void }) {
  const [project, setProject] = useState(workspace);
  const [displayName, setDisplayName] = useState(workspace.displayName ?? workspace.name);
  const [busy, setBusy] = useState<Maintenance | 'rename' | ''>('');
  const [error, setError] = useState('');
  const locked = useRef(false);
  async function run(kind: Maintenance, label: string, task: () => Promise<unknown>, message: string) {
    if (locked.current) return;
    locked.current = true;
    setBusy(kind); setError('');
    try { await task(); await onRefresh(); onCompleted(kind); notify(message); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : `${label}失败`); }
    finally { locked.current = false; setBusy(''); }
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
        <div className="project-dialog-operation"><div><h3>清空会话</h3><p>删除全部 {count} 个会话，保留项目记录。</p></div><Button size="sm" color="danger" variant="flat" isLoading={busy === 'clear'} isDisabled={!!busy} onPress={() => void run('clear', '清空', () => api.request(`/sessions?workspaceHash=${encodeURIComponent(workspace.hash)}`, 'DELETE'), '会话已清空')}>清空会话列表</Button></div>
        <div className="project-dialog-operation"><div><h3>删除项目</h3><p>移除项目及其会话，磁盘上的文件不受影响。</p></div><Button size="sm" color="danger" variant="flat" isLoading={busy === 'delete'} isDisabled={!!busy} onPress={() => void run('delete', '删除', () => api.request(`/workspaces/${encodeURIComponent(workspace.hash)}`, 'DELETE'), '项目已删除')}>删除项目</Button></div>
      </div>
      {error && <p role="alert" className="settings-error">{error}</p>}
    </ModalBody>
    <ModalFooter className="app-dialog-footer"><Button size="sm" variant="light" isDisabled={!!busy} onPress={onClose}>取消</Button></ModalFooter>
  </ModalContent></Modal>;
}
