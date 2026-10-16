import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { FileCode2, MessageSquare, RefreshCw, X } from 'lucide-react';
import type { LoopraClient } from '../backend';
import type { WorkspaceFile, WorkspaceTabs as TabsState } from '../workspace-tabs';
import { watchWorkspaceChanges } from '../workspace-events';
import { errorText, query } from './RemoteControls';
import UnifiedDiff from './UnifiedDiff';
import CodeViewer from './CodeViewer';

type Props = {
  api: LoopraClient; workspaceHash: string; state: TabsState; children: ReactNode;
  onSelect: (path: string | null) => void; onClose: (path: string) => void;
  onOpen: (file: WorkspaceFile) => void; onAdd: (path: string, selection?: string) => void;
};

export default function WorkspaceTabs({ api, workspaceHash, state, children, onSelect, onClose, onOpen, onAdd }: Props) {
  const bar = useRef<HTMLElement>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => watchWorkspaceChanges(workspaceHash, () => setRevision(value => value + 1)), [workspaceHash]);
  useEffect(() => { bar.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [state.active]);
  function navigate(event: KeyboardEvent<HTMLElement>) {
    if (!(event.target as HTMLElement).matches('[role="tab"]') || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = Array.from(bar.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') || []);
    const index = tabs.indexOf(event.target as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next]?.click(); tabs[next]?.focus();
  }
  return <div className="workspace-center">
    {state.files.length > 0 && <nav className="workspace-tabs" ref={bar} role="tablist" aria-label="主页面标签" onKeyDown={navigate}>
      <button type="button" className="workspace-chat-tab" role="tab" id="workspace-chat-tab" aria-controls="workspace-chat-view" aria-selected={state.active === null} tabIndex={state.active === null ? 0 : -1} onClick={() => onSelect(null)}><MessageSquare size={15} />会话</button>
      <div className="workspace-file-tabs">{state.files.map((file, index) => <div className="workspace-file-tab" key={file.path} data-active={state.active === file.path}>
        <button type="button" role="tab" id={`workspace-file-tab-${index}`} aria-controls={`workspace-file-view-${index}`} aria-selected={state.active === file.path} tabIndex={state.active === file.path ? 0 : -1} title={file.path} onClick={() => onSelect(file.path)}><FileCode2 size={14} /><span>{file.path.split('/').pop()}</span>{file.mode === 'diff' && <small>Diff</small>}</button>
        <button type="button" className="workspace-tab-close" aria-label={`关闭 ${file.path}`} onClick={() => onClose(file.path)}><X size={13} /></button>
      </div>)}</div>
    </nav>}
    <div className="workspace-chat-view" id="workspace-chat-view" role={state.files.length ? 'tabpanel' : undefined} aria-labelledby={state.files.length ? 'workspace-chat-tab' : undefined} hidden={state.active !== null}>{children}</div>
    {state.files.map((file, index) => <div className="workspace-file-view" id={`workspace-file-view-${index}`} role="tabpanel" aria-labelledby={`workspace-file-tab-${index}`} hidden={state.active !== file.path} key={file.path}>
      <WorkspaceFileView api={api} workspaceHash={workspaceHash} file={file} revision={revision} active={state.active === file.path} onMode={mode => onOpen({ ...file, mode })} onAdd={onAdd} />
    </div>)}
  </div>;
}

type FileData = { content?: string | null; exists?: boolean; message?: string; diff?: string };
function WorkspaceFileView({ api, workspaceHash, file, revision, active, onMode, onAdd }: { api: LoopraClient; workspaceHash: string; file: WorkspaceFile; revision: number; active: boolean; onMode: (mode: WorkspaceFile['mode']) => void; onAdd: Props['onAdd'] }) {
  const [state, setState] = useState<{ data?: FileData; loading: boolean; error: string }>({ loading: true, error: '' });
  const [reload, setReload] = useState(0);
  const [selection, setSelection] = useState('');
  const body = useRef<HTMLDivElement>(null);
  const loadedKey = useRef('');
  useEffect(() => {
    setSelection('');
    const key = `${workspaceHash}/${file.path}/${file.mode}`;
    const sameFile = loadedKey.current === key; loadedKey.current = key;
    if (file.mode === 'diff' && file.diff !== undefined) { setState({ data: { diff: file.diff }, loading: false, error: '' }); return; }
    const controller = new AbortController();
    setState(current => ({ data: sameFile ? current.data : undefined, loading: true, error: '' }));
    const endpoint = file.mode === 'diff' ? '/git/diff-content' : '/git/working-file-content';
    void api.request<FileData>(`${endpoint}?${query({ workspaceHash, path: file.path })}`, 'GET', undefined, controller.signal)
      .then(data => { if (!controller.signal.aborted) setState({ data, loading: false, error: '' }); })
      .catch(cause => { if (!controller.signal.aborted) setState(current => ({ ...current, loading: false, error: errorText(cause) })); });
    return () => controller.abort();
  }, [api, workspaceHash, file.path, file.mode, file.diff, revision, reload]);
  // The diff view is plain DOM, so its selection comes from the document; the
  // code preview is a Monaco editor, which reports its own selection instead.
  function selectText(event: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>) {
    if (event.target instanceof Element && event.target.closest('.workspace-code-editor')) return;
    const selected = window.getSelection();
    setSelection(selected?.anchorNode && selected.focusNode && body.current?.contains(selected.anchorNode) && body.current.contains(selected.focusNode) ? selected.toString().trim() : '');
  }
  const data = state.data;
  return <>
    <header className="workspace-file-toolbar"><span className="workspace-file-path" title={file.path}>{file.path}</span><div className="workspace-file-actions">
      <div className="workspace-view-modes" role="tablist" aria-label="文件视图"><button type="button" role="tab" aria-selected={file.mode === 'content'} onClick={() => onMode('content')}>原文件</button><button type="button" role="tab" aria-selected={file.mode === 'diff'} onClick={() => onMode('diff')}>{file.diff !== undefined ? '本次改动' : 'Git Diff'}</button></div>
      <button type="button" onClick={() => onAdd(file.path, selection || undefined)}>{selection ? '引用选中内容' : '引用文件'}</button>
      <button type="button" className="workspace-file-refresh" aria-label="刷新文件" disabled={state.loading || (file.mode === 'diff' && file.diff !== undefined)} onClick={() => setReload(value => value + 1)}><RefreshCw size={14} /></button>
    </div></header>
    <div className={`workspace-file-body${file.mode === 'diff' ? ' is-diff' : ' is-code'}`} ref={body} onMouseUp={selectText} onKeyUp={selectText}>
      {state.error ? <p className="settings-error" role="alert">{state.error}<button type="button" onClick={() => setReload(value => value + 1)}>重试</button></p> : state.loading && !data ? <p className="panel-empty" role="status">正在读取文件…</p> : file.mode === 'diff' ? <UnifiedDiff diff={data?.diff} path={file.path} nav emptyText="该文件没有未提交的改动。" /> : data?.exists && typeof data.content === 'string' ? <CodeViewer path={file.path} content={data.content} active={active} onSelect={setSelection} /> : <p className="panel-empty">{data?.message || '当前项目中未找到此文件，可能已移动或删除。'}</p>}
    </div>
  </>;
}
