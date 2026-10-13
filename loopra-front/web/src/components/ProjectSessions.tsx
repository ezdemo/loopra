import { useState } from 'react';
import { Button, Modal, ModalContent } from '@nextui-org/react';
import type { LoopraClient, Workspace } from '../backend';

type Maintenance = 'refresh' | 'clear' | 'delete';

// Ported from App.vue's "管理项目会话" dialog: refresh the project's sessions,
// clear them all, or drop the project record from Loopra.
export default function ProjectSessions({ api, workspace, count, onClose, onRefresh, onCompleted, notify }: { api: LoopraClient; workspace: Workspace; count: number; onClose: () => void; onRefresh: () => Promise<void>; onCompleted: (kind: Maintenance) => void; notify: (message: string) => void }) {
  const [busy, setBusy] = useState<Maintenance | ''>('');
  const [error, setError] = useState('');
  async function run(kind: Maintenance, label: string, task: () => Promise<unknown>, message: string) {
    setBusy(kind); setError('');
    try { await task(); await onRefresh(); onCompleted(kind); notify(message); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : `${label}失败`); }
    finally { setBusy(''); }
  }
  return <Modal isOpen onClose={() => { if (!busy) onClose(); }} isDismissable={!busy} placement="center" aria-label="管理项目会话"><ModalContent><div className="remote-confirm project-sessions-dialog">
    <h2>管理项目会话</h2>
    <p>“{workspace.name}”的会话可单独清空，或连同项目记录一起删除。</p>
    <p className="section-note">{workspace.path} · {count} 个会话</p>
    {error && <p role="alert" className="settings-error">{error}</p>}
    <div className="form-buttons project-session-actions">
      <Button variant="light" isDisabled={!!busy} onPress={onClose}>取消</Button>
      <Button variant="flat" isLoading={busy === 'refresh'} isDisabled={!!busy} onPress={() => void run('refresh', '刷新', async () => {}, '会话列表已刷新')}>刷新会话列表</Button>
      <Button color="primary" variant="flat" isLoading={busy === 'clear'} isDisabled={!!busy} onPress={() => void run('clear', '清空', () => api.request(`/sessions?workspaceHash=${encodeURIComponent(workspace.hash)}`, 'DELETE'), '会话已清空')}>清空会话列表</Button>
      <Button color="danger" isLoading={busy === 'delete'} isDisabled={!!busy} onPress={() => void run('delete', '删除', () => api.request(`/workspaces/${encodeURIComponent(workspace.hash)}`, 'DELETE'), '项目已删除')}>删除项目</Button>
    </div>
  </div></ModalContent></Modal>;
}
