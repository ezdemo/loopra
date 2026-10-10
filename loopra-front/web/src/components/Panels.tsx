import { Enter, SelectionIndicator } from './Motion';
import { useEffect, useState } from 'react';
import { Button, Spinner } from '@nextui-org/react';
import { Copy, FileCode2, Folder, GitBranch, List, Maximize, RefreshCw, SquareTerminal, TreePine, X } from 'lucide-react';
import { IconButton } from './ui';
import type { LoopraClient } from '../backend';

type GitFile = { path: string; status: string };
type GitStatus = { initialized: boolean; branch: string; changed: GitFile[]; untracked: GitFile[] };
type PanelProps = { api: LoopraClient; workspaceHash: string; onClose: () => void };
export default function ChangesPanel({ api, workspaceHash, onClose, notify, initialFile = null }: PanelProps & { notify: (message: string) => void; initialFile?: string | null }) {
  const [view, setView] = useState('列表');
  const [file, setFile] = useState<string | null>(initialFile);
  const [wide, setWide] = useState(false);
  const [status, setStatus] = useState<GitStatus>();
  const [diff, setDiff] = useState('');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (initialFile) setFile(initialFile); }, [initialFile]);
  useEffect(() => {
    const controller = new AbortController(); setBusy(true); setError('');
    if (!workspaceHash) { setError('请先选择工作区'); setBusy(false); return; }
    void api.request<GitStatus>(`/git/status?workspaceHash=${encodeURIComponent(workspaceHash)}`, 'GET', undefined, controller.signal).then(data => { if (!controller.signal.aborted) setStatus(data); }).catch(cause => { if (!controller.signal.aborted) setError(String(cause.message || cause)); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [api, workspaceHash, revision]);
  useEffect(() => {
    setDiff(''); if (!file || !workspaceHash) return;
    const controller = new AbortController();
    void api.request<{ diff: string }>(`/git/diff-content?workspaceHash=${encodeURIComponent(workspaceHash)}&path=${encodeURIComponent(file)}`, 'GET', undefined, controller.signal).then(data => { if (!controller.signal.aborted) setDiff(data.diff || '该文件没有可显示的文本差异。'); }).catch(cause => { if (!controller.signal.aborted) setDiff(String(cause.message || cause)); });
    return () => controller.abort();
  }, [api, workspaceHash, file, revision]);
  const files = [...(status?.changed || []), ...(status?.untracked || [])];
  return <aside className={`changes-panel ${wide ? 'wide' : ''}`} aria-label="改动面板">
    <header className="panel-header"><span className="panel-tab"><GitBranch size="1.0625rem" />改动</span><div><IconButton label="刷新改动" onClick={() => setRevision(value => value + 1)}><RefreshCw size="1.0625rem" /></IconButton><IconButton label="展开改动面板" onClick={() => setWide(!wide)}><Maximize size="1rem" /></IconButton><IconButton label="收起改动面板" onClick={onClose}><X size="1.0625rem" /></IconButton></div></header>
    <div className="changes-toolbar"><span><GitBranch size="0.9375rem" /><strong>{status?.branch || '工作区'}</strong><small>{files.length} 个文件</small></span><div className="file-view-toggle">{['列表', '树形'].map(name => <button key={name} aria-label={`${name}视图`} className={view === name ? 'selected' : ''} onClick={() => setView(name)}>{view === name && <SelectionIndicator />}{name === '列表' ? <List size="1rem" /> : <TreePine size="1rem" />}{name}</button>)}</div></div>
    {busy && <Spinner size="sm" />}{error && <p className="panel-empty" role="alert">{error}</p>}
    <div className="changed-files">{view === '树形' && <div className="tree-root"><Folder size="1rem" />工作区</div>}{files.map(item => <button className={`${view === '树形' ? 'tree-child' : ''} ${file === item.path ? 'selected' : ''}`} key={item.path} onClick={() => setFile(file === item.path ? null : item.path)}><span className="file-plus">{item.status || 'M'}</span>{item.path}</button>)}</div>
    {!busy && !error && !files.length && <p className="panel-empty">{status?.initialized ? '工作区没有未提交的改动' : '当前工作区尚未初始化 Git 仓库'}</p>}
    {file && <Enter key={file} className="diff-view"><div className="diff-heading"><FileCode2 size="0.9375rem" /><span>{file}</span><IconButton label="复制文件路径" onClick={() => { void navigator.clipboard?.writeText(file); notify('已复制文件路径'); }}><Copy size="0.875rem" /></IconButton></div><pre className="real-diff">{diff || '正在读取差异…'}</pre></Enter>}
  </aside>;
}

type BashSession = { sessionId: string; command: string; workdir: string; status: string };
export function TerminalPanel({ api, workspaceHash, onClose }: PanelProps & { initialShell?: string }) {
  const [sessions, setSessions] = useState<BashSession[]>([]);
  const [selected, setSelected] = useState('');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        if (!workspaceHash) return;
        const list = await api.request<BashSession[]>(`/agent/bash-sessions?workspaceHash=${encodeURIComponent(workspaceHash)}`, 'GET', undefined, controller.signal);
        if (controller.signal.aborted) return;
        setSessions(list); setError('');
        const id = list.some(item => item.sessionId === selected) ? selected : list[0]?.sessionId;
        if (id) { setSelected(id); const log = await api.request<{ output: string }>(`/agent/bash-sessions/log?workspaceHash=${encodeURIComponent(workspaceHash)}&sessionId=${encodeURIComponent(id)}`, 'GET', undefined, controller.signal); if (!controller.signal.aborted) setOutput(log.output); }
        else { setSelected(''); setOutput('暂无后台命令。让 Agent 执行 bash_start 后，这里会显示真实的命令输出。'); }
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '读取失败'); }
    }
    void load(); const timer = setInterval(() => void load(), 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [api, workspaceHash, selected, revision]);
  async function terminate() {
    try { await api.request('/agent/bash-sessions/terminate', 'POST', { sessionId: selected, workspaceHash }); setRevision(value => value + 1); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '停止失败'); }
  }
  return <section className="terminal-panel" aria-label="终端"><header><span><SquareTerminal size="1.0625rem" />后台终端输出</span><div className="backend-terminal-tabs">{sessions.map(item => <Button size="sm" variant={selected === item.sessionId ? 'flat' : 'light'} key={item.sessionId} onPress={() => setSelected(item.sessionId)}>{item.command.slice(0, 30)}</Button>)}</div>{sessions.find(item => item.sessionId === selected)?.status === 'running' && <Button size="sm" color="danger" variant="light" onPress={() => void terminate()}>停止进程</Button>}<IconButton label="刷新终端" onClick={() => setRevision(value => value + 1)}><RefreshCw size="1rem" /></IconButton><IconButton label="关闭终端" onClick={onClose}><X size="1.0625rem" /></IconButton></header><div className="terminal-output"><pre>{error || output}</pre></div></section>;
}
