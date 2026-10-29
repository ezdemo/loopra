import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Bot, FileCode2, MessageSquare, RefreshCw, X } from 'lucide-react';
import type { LoopraClient } from '../backend';
import { subAgentTabKey, type WorkspaceFile, type WorkspaceTabs as TabsState } from '../workspace-tabs';
import { watchWorkspaceChanges } from '../workspace-events';
import { errorText, query } from './RemoteControls';
import CodeViewer from './CodeViewer';
import SubAgentView from './SubAgentView';

type Props = {
  api: LoopraClient; workspaceHash: string; state: TabsState; children: ReactNode;
  onSelect: (path: string | null) => void; onClose: (path: string) => void;
  onOpen: (file: WorkspaceFile) => void;
  notify: (message: string) => void; onCloseSubAgent: (subSessionId: string) => void;
};

export default function WorkspaceTabs({ api, workspaceHash, state, children, onSelect, onClose, onOpen, notify, onCloseSubAgent }: Props) {
  const bar = useRef<HTMLElement>(null);
  const [revision, setRevision] = useState(0);
  const [fileRevisions, setFileRevisions] = useState(new Map<string, number>());
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
  function middleClose(event: MouseEvent<HTMLElement>, close?: () => void) {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.type === 'auxclick') close?.();
  }
  const hasTabs = state.files.length + state.agents.length > 0;
  return <div className="workspace-center">
    {hasTabs && <nav className="workspace-tabs" ref={bar} role="tablist" aria-label="主页面标签" onKeyDown={navigate}>
      <button type="button" className="workspace-chat-tab" role="tab" id="workspace-chat-tab" aria-controls="workspace-chat-view" aria-selected={state.active === null} tabIndex={state.active === null ? 0 : -1} onClick={() => onSelect(null)} onMouseDown={middleClose} onAuxClick={middleClose}><MessageSquare size={15} />会话</button>
      <div className="workspace-file-tabs">{state.files.map((file, index) => <div className="workspace-file-tab" key={file.path} data-active={state.active === file.path} onMouseDown={middleClose} onAuxClick={event => middleClose(event, () => onClose(file.path))}>
        <button type="button" role="tab" id={`workspace-file-tab-${index}`} aria-controls={`workspace-file-view-${index}`} aria-selected={state.active === file.path} tabIndex={state.active === file.path ? 0 : -1} title={file.path} onClick={() => onSelect(file.path)}><FileCode2 size={14} /><span>{file.path.split('/').pop()}</span></button>
        <button type="button" className="workspace-tab-refresh" title="刷新文件" aria-label={`刷新 ${file.path}`} onClick={event => { event.stopPropagation(); setFileRevisions(current => new Map(current).set(file.path, (current.get(file.path) || 0) + 1)); }}><RefreshCw size={13} /></button>
        <button type="button" className="workspace-tab-close" aria-label={`关闭 ${file.path}`} onClick={() => onClose(file.path)}><X size={13} /></button>
      </div>)}
        {state.agents.map((agent, index) => {
          const key = subAgentTabKey(agent.subSessionId);
          return <div className="workspace-file-tab workspace-subagent-tab" key={key} data-active={state.active === key} onMouseDown={middleClose} onAuxClick={event => middleClose(event, () => onCloseSubAgent(agent.subSessionId))}>
            <button type="button" role="tab" id={`workspace-subagent-tab-${index}`} aria-controls={`workspace-subagent-view-${index}`} aria-selected={state.active === key} tabIndex={state.active === key ? 0 : -1} title={agent.label} onClick={() => onSelect(key)}><Bot size={14} /><span>{agent.label}</span></button>
            <button type="button" className="workspace-tab-close" aria-label={`关闭 ${agent.label}`} onClick={() => onCloseSubAgent(agent.subSessionId)}><X size={13} /></button>
          </div>;
        })}
      </div>
    </nav>}
    <div className="workspace-chat-view" id="workspace-chat-view" role={hasTabs ? 'tabpanel' : undefined} aria-labelledby={hasTabs ? 'workspace-chat-tab' : undefined} hidden={state.active !== null}>{children}</div>
    {state.files.map((file, index) => <div className="workspace-file-view" id={`workspace-file-view-${index}`} role="tabpanel" aria-labelledby={`workspace-file-tab-${index}`} hidden={state.active !== file.path} key={file.path}>
      <WorkspaceFileView api={api} workspaceHash={workspaceHash} file={file} revision={revision + (fileRevisions.get(file.path) || 0)} active={state.active === file.path} />
    </div>)}
    {state.agents.map((agent, index) => {
      const key = subAgentTabKey(agent.subSessionId);
      return <div className="workspace-file-view workspace-subagent-view" id={`workspace-subagent-view-${index}`} role="tabpanel" aria-labelledby={`workspace-subagent-tab-${index}`} hidden={state.active !== key} key={key}>
        <SubAgentView api={api} workspaceHash={workspaceHash} sessionName={agent.sessionName} subSessionId={agent.subSessionId} label={agent.label} notify={notify} onOpenFile={path => onOpen({ path, mode: 'content' })} onDiff={path => onOpen({ path, mode: 'content' })} />
      </div>;
    })}
  </div>;
}

type FileData = { content?: string | null; exists?: boolean; message?: string; diff?: string };
function WorkspaceFileView({ api, workspaceHash, file, revision, active }: { api: LoopraClient; workspaceHash: string; file: WorkspaceFile; revision: number; active: boolean }) {
  const [state, setState] = useState<{ data?: FileData; loading: boolean; error: string }>({ loading: true, error: '' });
  const [reload, setReload] = useState(0);
  const [gitDiff, setGitDiff] = useState<string>();
  const loadedKey = useRef('');
  useEffect(() => {
    setGitDiff(undefined);
    const key = `${workspaceHash}/${file.environment || ''}/${file.path}`;
    const sameFile = loadedKey.current === key; loadedKey.current = key;
    const controller = new AbortController();
    setState(current => ({ data: sameFile ? current.data : undefined, loading: true, error: '' }));
    // Worktree tabs go through the environment endpoints; their paths are
    // resolved by the backend from the session, never sent as arbitrary dirs.
    const endpoint = file.environment ? '/git/environment/working-file-content' : '/git/working-file-content';
    const params = file.environment ? { workspaceHash, sessionName: file.environment, path: file.path } : { workspaceHash, path: file.path };
    void api.request<FileData>(`${endpoint}?${query(params)}`, 'GET', undefined, controller.signal)
      .then(data => { if (!controller.signal.aborted) setState({ data, loading: false, error: '' }); })
      .catch(cause => { if (!controller.signal.aborted) setState(current => ({ ...current, loading: false, error: errorText(cause) })); });
    // Git can be unavailable or slow; the file preview loads independently.
    const diffEndpoint = file.environment ? '/git/environment/diff-content' : '/git/diff-content';
    void api.request<FileData>(`${diffEndpoint}?${query(params)}`, 'GET', undefined, controller.signal)
      .then(data => { if (!controller.signal.aborted) setGitDiff(data.diff); })
      .catch(() => {});
    return () => controller.abort();
  }, [api, workspaceHash, file.environment, file.path, revision, reload]);
  const data = state.data;
  const deletedFile = !data?.exists && /^@@ -\d+(?:,\d+)? \+0,0 @@/m.test(gitDiff || '');
  const content = data?.exists && typeof data.content === 'string' ? data.content : deletedFile ? '' : null;
  return <>
    <header className="workspace-file-toolbar"><span className="workspace-file-path" title={file.path}>{file.path}</span></header>
    <div className="workspace-file-body is-code">
      {state.error ? <p className="settings-error" role="alert">{state.error}<button type="button" onClick={() => setReload(value => value + 1)}>重试</button></p> : state.loading && !data ? <p className="panel-empty" role="status">正在读取文件…</p> : content !== null ? <CodeViewer path={file.path} content={content} gitDiff={gitDiff} active={active} /> : <p className="panel-empty">{data?.message || '当前项目中未找到此文件，可能已移动或删除。'}</p>}
    </div>
  </>;
}
