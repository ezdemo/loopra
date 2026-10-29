import { useEffect, useRef, useState } from 'react';
import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@nextui-org/react';
import { ArrowDown, ArrowUp, FolderClosed, FolderPlus, GripVertical, RefreshCw, Trash2 } from 'lucide-react';
import type { LoopraClient, Workspace } from '../backend';
import type { Session } from '../lib';

type Props = {
  api: LoopraClient; workspaces: Workspace[]; sessions: Session[]; current: string;
  onClose: () => void; onRefresh: () => Promise<Workspace[]>;
  onAdded: (workspace: Workspace) => void;
  onDeleted: (workspace: Workspace) => void; notify: (message: string) => void;
};

export default function ProjectManager({ api, workspaces, sessions, current, onClose, onRefresh, onAdded, onDeleted, notify }: Props) {
  const [items, setItems] = useState(workspaces);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState<Workspace>();
  const [dragging, setDragging] = useState('');
  const [over, setOver] = useState('');
  const locked = useRef(false);
  useEffect(() => { setItems(workspaces); }, [workspaces]);

  async function run(action: () => Promise<unknown>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { locked.current = false; setBusy(false); }
  }
  async function reload(saved = false) {
    try { const projects = await onRefresh(); setItems(projects); return projects; }
    catch (cause) { throw new Error(`${saved ? '操作已保存，刷新项目失败：' : '刷新项目失败：'}${cause instanceof Error ? cause.message : cause}`); }
  }
  async function reorder(from: string, to: string) {
    setDragging(''); setOver('');
    const source = items.findIndex(item => item.hash === from), target = items.findIndex(item => item.hash === to);
    if (source < 0 || target < 0 || source === target || !!removing) return;
    await run(async () => {
      const next = [...items]; const [moved] = next.splice(source, 1); next.splice(target, 0, moved);
      setItems(next);
      try { await api.request('/workspaces/order', 'PUT', next.map(item => item.hash)); }
      catch (cause) { setItems(items); throw cause; }
      notify('项目顺序已保存'); await reload(true);
    });
  }
  function addProject() {
    if (!path.trim() || !!removing) return;
    void run(() => openProject(path.trim()));
  }
  async function openProject(selected: string) {
    setPath(selected);
    const result = await api.request<{ workspace: string }>('/workspace', 'POST', { path: selected });
    const projects = await reload(true);
    const project = projects.find(item => item.path === result.workspace);
    if (!project) throw new Error('项目已添加，但未找到项目记录，请刷新后重试');
    setPath(''); onAdded(project); notify('已进入项目'); onClose();
  }
  function deleteProject(item: Workspace) {
    void run(async () => {
      await api.request(`/workspaces/${encodeURIComponent(item.hash)}`, 'DELETE');
      setItems(previous => previous.filter(project => project.hash !== item.hash));
      setRemoving(undefined); onDeleted(item); notify('项目已移除'); await reload(true);
    });
  }
  function chooseFolder() {
    void run(async () => {
      const selected = await api.request<string>('/system/pick-directory', 'POST', { path: path.trim() }, AbortSignal.timeout(130000));
      if (selected) await openProject(selected);
    });
  }
  return <Modal isOpen onClose={() => { if (!busy) onClose(); }} isDismissable={!busy} isKeyboardDismissDisabled={busy} placement="center" scrollBehavior="inside" classNames={{ base: 'app-dialog project-manager-dialog', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop', closeButton: 'app-dialog-close' }} aria-label="管理项目"><ModalContent>
    <ModalHeader className="app-dialog-header"><div className="project-manager-heading"><div><h2>管理项目</h2><span className="project-manager-total">{items.length}</span></div><p>拖动调整项目顺序，修改自动保存</p></div><Button className="project-manager-refresh" isIconOnly size="sm" variant="light" aria-label="刷新项目" title="刷新项目" isDisabled={busy || !!removing} onPress={() => void run(() => reload())}><RefreshCw size="1rem" /></Button></ModalHeader>
    <ModalBody className="project-manager-body">
      <ul className="project-manager-list" aria-label="项目列表">
        {items.map((item, index) => <li key={item.hash} data-project-hash={item.hash} className={`${dragging === item.hash ? 'is-dragging' : ''} ${over === item.hash ? 'is-drop-target' : ''}`} onDragOver={event => { if (dragging && !busy && !removing) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setOver(item.hash); } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(''); }} onDrop={event => { event.preventDefault(); if (dragging) void reorder(dragging, item.hash); }}>
          <button type="button" className="project-manager-grip" aria-label={`拖动排序 ${item.name}`} draggable={!busy && !removing} disabled={busy || !!removing} onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', item.hash); setDragging(item.hash); }} onDragEnd={() => { setDragging(''); setOver(''); }}><GripVertical size="1rem" /></button>
          <span className="project-manager-folder"><FolderClosed size="1.125rem" /></span>
          <div className="project-manager-info"><div><strong title={item.name}>{item.name}</strong>{current === item.hash && <span className="project-manager-current">当前</span>}</div><p title={item.path}>{item.path}</p></div>
          <span className="project-manager-count">{sessions.filter(session => session.workspaceHash === item.hash).length} 个会话</span>
          <div className="project-manager-actions"><Button isIconOnly size="sm" variant="light" aria-label={`上移 ${item.name}`} isDisabled={busy || !!removing || index === 0} onPress={() => void reorder(item.hash, items[index - 1].hash)}><ArrowUp size=".9375rem" /></Button><Button isIconOnly size="sm" variant="light" aria-label={`下移 ${item.name}`} isDisabled={busy || !!removing || index === items.length - 1} onPress={() => void reorder(item.hash, items[index + 1].hash)}><ArrowDown size=".9375rem" /></Button><Button isIconOnly size="sm" variant="light" className="project-manager-remove" aria-label={`移除 ${item.name}`} isDisabled={busy || !!removing} onPress={() => { setError(''); setRemoving(item); }}><Trash2 size=".9375rem" /></Button></div>
        </li>)}
        {!items.length && <li className="project-manager-empty"><FolderPlus size="1.5rem" /><strong>还没有项目</strong><p>添加一个项目文件夹，开始新的会话。</p></li>}
      </ul>
    </ModalBody>
    <ModalFooter className="project-manager-footer">
      {removing ? <div className="project-manager-confirm" role="alertdialog" aria-label="移除项目"><strong>移除「{removing.name}」？</strong><p>该项目及其会话记录将从 Loopra 移除，磁盘上的文件不会被删除。</p><div><Button autoFocus size="sm" variant="light" isDisabled={busy} onPress={() => setRemoving(undefined)}>取消</Button><Button size="sm" color="danger" variant="flat" isDisabled={busy} isLoading={busy} onPress={() => deleteProject(removing)}>确认移除</Button></div></div> : <form className="project-manager-add" onSubmit={event => { event.preventDefault(); addProject(); }}><label htmlFor="project-manager-path">新增项目</label><div><div className="project-manager-path"><FolderClosed size="1rem" /><input id="project-manager-path" value={path} disabled={busy} onChange={event => setPath(event.target.value)} placeholder="输入项目文件夹的绝对路径" autoComplete="off" /></div><Button isIconOnly size="sm" variant="bordered" aria-label="选择项目文件夹" title="选择文件夹并进入项目" isDisabled={busy} onPress={chooseFolder}><FolderClosed size="1rem" /></Button><Button size="sm" type="submit" color="primary" isDisabled={busy || !path.trim()}><FolderPlus size="1rem" />添加项目</Button></div></form>}
      {error && <p className="project-manager-error" role="alert">{error}</p>}
    </ModalFooter>
  </ModalContent></Modal>;
}
