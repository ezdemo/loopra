import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Input, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@nextui-org/react';
import { Trash2 } from 'lucide-react';
import type { LoopraClient, ProjectLinks, Workspace } from '../backend';
import type { Session } from '../lib';
import { SelectField } from './SettingControls';

type Maintenance = 'clear-all' | 'delete';
type MaintenanceResult = Maintenance | 'clear-old';
type CleanupPeriod = 3 | 7 | 30;
type CleanupScope = `${CleanupPeriod}` | 'all';
type BusyOperation = Maintenance | `clear:${CleanupPeriod}` | 'rename' | 'link-path' | 'pick-directory' | '';

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
export default function ProjectSessions({ api, workspace, workspaces = [], count, sessions, onClose, onRefresh, onCompleted, onRenamed, onUpdated, notify }: { api: LoopraClient; workspace: Workspace; workspaces?: Workspace[]; count: number; sessions?: Session[]; onClose: () => void; onRefresh: () => Promise<void>; onCompleted: (kind: MaintenanceResult, sessionNames?: string[]) => void; onRenamed?: (previous: Workspace, renamed: Workspace) => void; onUpdated?: (hash: string, links: ProjectLinks) => void; notify: (message: string) => void }) {
  const [project, setProject] = useState(workspace);
  const chat = workspace.kind === 'chat';
  const title = chat ? '管理纯聊天会话' : '管理项目会话';
  const [displayName, setDisplayName] = useState(workspace.displayName ?? workspace.name);
  const [links, setLinks] = useState<ProjectLinks>({ linkedProjectHashes: workspace.linkedProjectHashes ?? [], linkedProjectPaths: workspace.linkedProjectPaths ?? [] });
  const { linkedProjectHashes: linkedHashes, linkedProjectPaths: linkedPaths } = links;
  const linkCount = linkedHashes.length + linkedPaths.length;
  const [savingLinks, setSavingLinks] = useState(false);
  const [linkPath, setLinkPath] = useState('');
  const [choosingProject, setChoosingProject] = useState(false);
  const desiredLinks = useRef(links);
  const confirmedLinks = useRef(links);
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
  const pathName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
  function updateLinks(next: ProjectLinks) {
    desiredLinks.current = next; linkVersion.current++;
    setLinks(next); setError('');
  }
  function removeLink(link: { hash?: string; path?: string }) {
    if (locked.current) return;
    const current = desiredLinks.current;
    updateLinks({
      linkedProjectHashes: link.hash ? current.linkedProjectHashes.filter(value => value !== link.hash) : current.linkedProjectHashes,
      linkedProjectPaths: link.path ? current.linkedProjectPaths.filter(value => value !== link.path) : current.linkedProjectPaths,
    });
    void saveLinkedProjects();
  }
  // 已有项目只用来挑选目录：关联始终按目录保存，和「选择文件夹」一致。
  // 这样删除项目列表中的记录不会让已有关联失效。
  function toggleProject(item: Workspace) {
    if (locked.current) return;
    const current = desiredLinks.current;
    if (current.linkedProjectHashes.includes(item.hash) || current.linkedProjectPaths.includes(item.path)) {
      removeLink({ hash: item.hash, path: item.path });
      return;
    }
    if (current.linkedProjectHashes.length + current.linkedProjectPaths.length >= 8) return;
    updateLinks({ linkedProjectHashes: current.linkedProjectHashes, linkedProjectPaths: [...current.linkedProjectPaths, item.path] });
    void saveLinkedProjects();
  }
  async function addLinkedProject(pickDirectory = false) {
    if (locked.current || linkWorker.current || linkCount >= 8) return;
    if (!pickDirectory && !linkPath.trim()) return;
    locked.current = true; setBusy(pickDirectory ? 'pick-directory' : 'link-path'); setError('');
    try {
      let path = linkPath.trim();
      if (pickDirectory) {
        path = await api.request<string>('/system/pick-directory', 'POST', { path }, AbortSignal.timeout(130000));
        if (!path) return;
        setLinkPath(path);
        setBusy('link-path');
      }
      if (desiredLinks.current.linkedProjectPaths.includes(path) || candidates.some(item => item.path === path && desiredLinks.current.linkedProjectHashes.includes(item.hash))) {
        setLinkPath('');
        notify('该目录已关联');
        return;
      }
      updateLinks({ ...desiredLinks.current, linkedProjectPaths: [...desiredLinks.current.linkedProjectPaths, path] });
      if (await saveLinkedProjects()) setLinkPath('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '关联项目失败');
    } finally {
      locked.current = false; setBusy('');
    }
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
    if (linkWorker.current) return false;
    linkWorker.current = true; setSavingLinks(true);
    const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((value, index) => value === b[index]);
    const sameLinks = (a: ProjectLinks, b: ProjectLinks) => sameList(a.linkedProjectHashes, b.linkedProjectHashes) && sameList(a.linkedProjectPaths, b.linkedProjectPaths);
    let saved = false, failed = false;
    // 每个弹窗只保留一个请求在途；后续勾选合并成最新快照，关闭后继续提交。
    while (!sameLinks(desiredLinks.current, confirmedLinks.current)) {
      const next = desiredLinks.current;
      try {
        const updated = await api.request<Workspace>(`/workspaces/${encodeURIComponent(workspace.hash)}/links`, 'PUT', next);
        confirmedLinks.current = { linkedProjectHashes: updated.linkedProjectHashes ?? [], linkedProjectPaths: updated.linkedProjectPaths ?? [] };
        saved = true;
        if (sameLinks(desiredLinks.current, next)) {
          desiredLinks.current = confirmedLinks.current;
          if (mounted.current) setLinks(confirmedLinks.current);
        }
      } catch (cause) {
        if (!sameLinks(desiredLinks.current, next)) continue;
        desiredLinks.current = confirmedLinks.current; failed = true;
        const detail = cause instanceof Error ? cause.message : '保存关联失败';
        if (mounted.current) { setLinks(confirmedLinks.current); setError(detail); }
        else notify(`关联副项目保存失败：${detail}`);
      }
    }
    linkWorker.current = false;
    if (mounted.current) {
      setSavingLinks(false);
      setProject(previous => ({ ...previous, ...confirmedLinks.current }));
      if (saved) onUpdated?.(workspace.hash, confirmedLinks.current);
    }
    if (!saved) return !failed;
    if (!failed) notify('关联副项目已保存，将在下一轮生效');
    const version = linkVersion.current;
    try { await onRefresh(); }
    catch (cause) {
      if (mounted.current && linkVersion.current === version) setError(`关联已保存，刷新项目失败：${cause instanceof Error ? cause.message : '刷新失败'}`);
    }
    return !failed;
  }
  function projectChoices(items: Workspace[]) {
    return <>
      {items.map(item => {
        const selected = linkedHashes.includes(item.hash) || linkedPaths.includes(item.path);
        return <Checkbox key={item.hash} size="sm" classNames={{ base: 'project-dialog-link', label: 'project-dialog-link-info' }} isSelected={selected} isDisabled={!!busy || (!selected && linkCount >= 8)} onValueChange={() => toggleProject(item)}>
          <strong>{item.name}</strong><small>{item.path}</small>
        </Checkbox>;
      })}
      {missingLinks.map(hash => <Checkbox key={hash} size="sm" classNames={{ base: 'project-dialog-link', label: 'project-dialog-link-info' }} isSelected isDisabled={!!busy} onValueChange={() => removeLink({ hash })}><strong>项目已移除</strong><small>{hash} · 取消勾选以解除关联</small></Checkbox>)}
    </>;
  }
  return <><Modal isOpen onClose={() => { if (!busy && !choosingProject) onClose(); }} isDismissable={!busy && !choosingProject} isKeyboardDismissDisabled={!!busy || choosingProject} placement="center" scrollBehavior="inside" classNames={{ base: 'app-dialog project-sessions-dialog', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop', closeButton: 'app-dialog-close' }} aria-label={title}><ModalContent>
    <ModalHeader className="app-dialog-header"><h2>{title}</h2></ModalHeader>
    <ModalBody className="app-dialog-body">
      <div className="project-dialog-summary"><div><strong>{project.name}</strong><span>{count} 个会话</span></div>{project.path && <p>{project.path}</p>}</div>
      {!chat && <form className="project-dialog-rename" onSubmit={event => { event.preventDefault(); void renameProject(); }}>
        <label htmlFor="project-session-display-name">项目展示名称</label>
        <div><Input id="project-session-display-name" aria-label="项目展示名称" value={displayName} maxLength={80} isDisabled={!!busy} onValueChange={setDisplayName} autoComplete="off" placeholder="留空恢复文件夹名称" size="md" variant="bordered" radius="lg" className="settings-field project-dialog-input" classNames={{ inputWrapper: 'project-dialog-input-wrapper' }} /><Button type="submit" size="sm" color="primary" isLoading={busy === 'rename'} isDisabled={!!busy || displayName.trim() === (project.displayName ?? project.name)}>保存名称</Button></div>
        <p>最多 80 个字符，留空恢复文件夹名称。</p>
      </form>}
      {!chat && <section className="project-dialog-links" aria-label="关联副项目">
        <div className="project-dialog-links-heading"><h3>关联副项目</h3><span>{linkCount} / 8</span></div>
        <form className="project-dialog-link-add" onSubmit={event => { event.preventDefault(); void addLinkedProject(); }}>
          <Input aria-label="副项目路径" value={linkPath} onValueChange={setLinkPath} placeholder="输入项目文件夹的绝对路径" isDisabled={!!busy} isReadOnly={linkCount >= 8} autoComplete="off" size="md" variant="bordered" radius="lg" className="settings-field project-dialog-input" classNames={{ inputWrapper: 'project-dialog-input-wrapper' }}
            endContent={<Button type="button" size="sm" variant="light" className="project-dialog-link-picker-trigger" aria-haspopup="dialog" aria-expanded={choosingProject} isDisabled={!!busy} onPress={() => setChoosingProject(true)}>选择已有项目</Button>} />
          <div>
            <Button size="sm" variant="bordered" className="project-dialog-link-action" isLoading={busy === 'pick-directory'} isDisabled={!!busy || savingLinks || linkCount >= 8} onPress={() => void addLinkedProject(true)}>选择文件夹</Button>
            <Button size="sm" type="submit" color="primary" className="project-dialog-link-action" isLoading={busy === 'link-path'} isDisabled={!!busy || savingLinks || !linkPath.trim() || linkCount >= 8}>关联</Button>
          </div>
        </form>
        {linkCount > 0 && <ul className="project-dialog-links-list project-dialog-linked-list" aria-label="已关联副项目" aria-busy={savingLinks}>
          {linkedHashes.map(hash => {
            const item = candidates.find(candidate => candidate.hash === hash);
            return <li key={`hash:${hash}`} className="project-dialog-link">
              <div className="project-dialog-link-info"><strong>{item?.name ?? '项目已移除'}</strong><small>{item?.path ?? hash}</small></div>
              <Button isIconOnly size="sm" variant="light" className="project-dialog-link-remove" aria-label={`解除关联 ${item?.name ?? hash}`} title="解除关联" isDisabled={!!busy} onPress={() => removeLink({ hash })}><Trash2 size="1rem" /></Button>
            </li>;
          })}
          {linkedPaths.map(path => <li key={`path:${path}`} className="project-dialog-link">
            <div className="project-dialog-link-info"><strong>{pathName(path)}</strong><small>{path}</small></div>
            <Button isIconOnly size="sm" variant="light" className="project-dialog-link-remove" aria-label={`解除关联 ${pathName(path)}`} title="解除关联" isDisabled={!!busy} onPress={() => removeLink({ path })}><Trash2 size="1rem" /></Button>
          </li>)}
        </ul>}
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
      {error && !choosingProject && <p role="alert" className="settings-error">{error}</p>}
    </ModalBody>
    <ModalFooter className="app-dialog-footer"><Button size="sm" variant="light" isDisabled={!!busy} onPress={onClose}>关闭</Button></ModalFooter>
  </ModalContent></Modal>
    {choosingProject && <Modal isOpen onClose={() => setChoosingProject(false)} placement="center" scrollBehavior="inside" classNames={{ base: 'app-dialog project-picker-dialog', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop', closeButton: 'app-dialog-close' }} aria-label="选择已有项目"><ModalContent>
      <ModalHeader className="app-dialog-header"><h2>选择已有项目</h2><span className="project-picker-count">{linkCount} / 8</span></ModalHeader>
      <ModalBody className="app-dialog-body">
        <div className="project-dialog-links-list project-picker-list" aria-busy={savingLinks}>
          {projectChoices(candidates)}
          {!candidates.length && !missingLinks.length && <p>暂无已有项目，可输入路径或选择文件夹关联。</p>}
        </div>
        {error && <p role="alert" className="settings-error">{error}</p>}
      </ModalBody>
      <ModalFooter className="app-dialog-footer"><Button size="sm" variant="light" onPress={() => setChoosingProject(false)}>完成</Button></ModalFooter>
    </ModalContent></Modal>}
  </>;
}
