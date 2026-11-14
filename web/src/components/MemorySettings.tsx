import { useEffect, useRef, useState } from 'react';
import { Button } from '@nextui-org/react';
import { Plus, RefreshCw, Search } from 'lucide-react';
import type { LoopraClient, Workspace } from '../backend';
import { isProjectWorkspace } from '../custom-agents';
import { memoryPath, type MemoryEntry } from '../memory';
import { EmptySetting, Field, PageActions, SelectField, SettingSegments, TextField } from './SettingControls';
import { ConfirmAction, errorText, RemoteState, useRemote } from './RemoteControls';
import './memory-settings.css';

type Props = {
  api: LoopraClient;
  workspaces: Workspace[];
  initialWorkspaceHash?: string;
  onNestedDialog: (open: boolean) => void;
};

export default function MemorySettings({ api, workspaces, initialWorkspaceHash, onNestedDialog }: Props) {
  const projects = workspaces.filter(isProjectWorkspace);
  const [scope, setScope] = useState<'global' | 'project'>('global');
  const [selected, setSelected] = useState(initialWorkspaceHash || '');
  const workspace = projects.find(item => item.hash === selected)?.hash || projects[0]?.hash || '';
  return <>
    <PageActions title="记忆" />
    <div className="memory-scope-controls">
      <SettingSegments label="记忆范围" options={['全局', '项目']} value={scope === 'global' ? '全局' : '项目'} onChange={value => setScope(value === '全局' ? 'global' : 'project')} />
      <div className="memory-project-selector" data-hidden={scope !== 'project'} aria-hidden={scope !== 'project'}>
        {projects.length > 0 && <SelectField compact label="记忆所属项目" value={workspace} onChange={setSelected} options={projects.map(item => ({ value: item.hash, label: item.name }))} disabled={scope !== 'project'} />}
      </div>
    </div>
    {scope === 'project' && !workspace ? <EmptySetting>添加项目后即可管理项目记忆。</EmptySetting> : <MemoryCollection key={`${api.base}/${scope}/${workspace}`} api={api} scope={scope} workspace={workspace} onNestedDialog={onNestedDialog} />}
  </>;
}

function MemoryCollection({ api, scope, workspace, onNestedDialog }: { api: LoopraClient; scope: 'global' | 'project'; workspace: string; onNestedDialog: (open: boolean) => void }) {
  const [revision, setRevision] = useState(0);
  const { data, loading, error } = useRemote<MemoryEntry[]>(api, memoryPath(scope, workspace), revision);
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<MemoryEntry | 'new'>();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [kind, setKind] = useState<MemoryEntry['kind']>('fact');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [removing, setRemoving] = useState<MemoryEntry>();
  const lifetime = useRef(new AbortController());
  useEffect(() => {
    lifetime.current = new AbortController();
    return () => lifetime.current.abort();
  }, []);
  useEffect(() => {
    if (!removing) return;
    onNestedDialog(true);
    return () => onNestedDialog(false);
  }, [removing, onNestedDialog]);

  function edit(entry?: MemoryEntry) {
    setTitle(entry?.title || '');
    setContent(entry?.content || '');
    setKind(entry?.kind || 'fact');
    setSaveError('');
    setEditor(entry || 'new');
  }
  async function save() {
    if (busy || !editor) return;
    setBusy(true);
    setSaveError('');
    const signal = lifetime.current.signal;
    try {
      const entry = editor === 'new' ? undefined : editor;
      await api.request(memoryPath(scope, workspace, entry?.id), entry ? 'PUT' : 'POST', {
        title: title.trim(), content: content.trim(), kind, revision: entry?.revision || 0,
      }, signal);
      if (!signal.aborted) { setEditor(undefined); setRevision(value => value + 1); }
    } catch (cause) {
      if (!signal.aborted) setSaveError(errorText(cause));
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }

  if (editor) return <form className="memory-editor rich-settings-form" onSubmit={event => { event.preventDefault(); void save(); }}>
    <PageActions title={editor === 'new' ? '添加记忆' : '编辑记忆'} onBack={() => { if (!busy) { setEditor(undefined); setRevision(value => value + 1); } }} />
    <Field label="标题" value={title} onChange={setTitle} maxLength={120} required disabled={busy} />
    <SelectField label="类型" value={kind} onChange={value => { if (value === 'fact' || value === 'preference' || value === 'environment') setKind(value); }} options={[{ value: 'fact', label: '背景与事实' }, { value: 'preference', label: '偏好' }, { value: 'environment', label: '系统环境' }]} disabled={busy} />
    <TextField label="内容" value={content} onChange={setContent} rows={6} maxLength={4000} required disabled={busy} placeholder={scope === 'global' ? '例如：本机使用 nvm 管理 Node.js 版本，执行前先检查当前版本。' : '例如：本项目使用 pnpm，提交前运行 pnpm test 和 pnpm build。'} />
    {saveError && <p className="settings-error" role="alert">{saveError}</p>}
    <div className="settings-save-row"><Button variant="light" isDisabled={busy} onPress={() => { setEditor(undefined); setRevision(value => value + 1); }}>取消</Button><Button type="submit" color="primary" isLoading={busy} isDisabled={!title.trim() || !content.trim()}>保存</Button></div>
  </form>;

  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const entries = data?.filter(entry => words.every(word => `${entry.title} ${entry.content}`.toLowerCase().includes(word)));
  return <>
    <div className="memory-list-controls">
      <Field label="搜索记忆" aria-label="搜索记忆" value={query} onChange={setQuery} startContent={<Search size="1rem" aria-hidden="true" />} />
      <Button size="sm" variant="light" startContent={<RefreshCw size="1rem" />} isDisabled={loading} onPress={() => setRevision(value => value + 1)}>刷新</Button>
      <Button size="sm" color="primary" startContent={<Plus size="1rem" />} isDisabled={loading || !!error} onPress={() => edit()}>添加</Button>
    </div>
    <RemoteState loading={loading} error={error} />
    {!loading && !error && entries?.length === 0 && <EmptySetting>{query.trim() ? '没有找到匹配的记忆。' : scope === 'global' ? '还没有全局记忆。可以记录个人偏好和本机环境。' : '还没有项目记忆。可以记录项目背景、约定和决策。'}</EmptySetting>}
    {!!entries?.length && <div className="memory-list">{entries.map(entry => <article key={entry.id} className="memory-entry">
      <div className="memory-entry-heading"><h3>{entry.title}</h3><div className="workbench-actions"><Button size="sm" variant="light" onPress={() => edit(entry)} aria-label={`编辑 ${entry.title}`}>编辑</Button><Button size="sm" variant="light" color="danger" onPress={() => setRemoving(entry)} aria-label={`删除 ${entry.title}`}>删除</Button></div></div>
      <p>{entry.content}</p>
    </article>)}</div>}
    {removing && <ConfirmAction title="删除记忆" onClose={() => setRemoving(undefined)} action={() => api.request(memoryPath(scope, workspace, removing.id, removing.revision), 'DELETE', undefined, lifetime.current.signal)} onDone={() => setRevision(value => value + 1)}><p>删除“{removing.title}”？</p></ConfirmAction>}
  </>;
}
