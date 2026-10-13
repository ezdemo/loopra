import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Button } from '@nextui-org/react';
import { Maximize, RefreshCw, SquareTerminal, X } from 'lucide-react';
import { IconButton } from './ui';
import type { LoopraClient } from '../backend';
import type { Session } from '../lib';
import { useLocalState } from '../lib';
import { DEFAULT_PANEL_WIDTH, WIDE_PANEL_WIDTH, resizePanelWidth } from '../panel-resize';
import FilesPanel from './FilesPanel';
import GitTools from './GitTools';
import DiffView from './DiffView';
import SchedulePanel from './SchedulePanel';
import SubAgentsPanel from './SubAgentsPanel';
import ProjectCapabilities from './ProjectCapabilities';
import { RemoteState, errorText, query, useRemote } from './RemoteControls';
import { bashSessionLogPath, bashSessionState, bashSessionSummary, bashSessionsPath, formatBashUptime, type BashSession } from '../bash-sessions';

type PanelProps = { api: LoopraClient; workspaceHash: string; onClose: () => void };
type WorkbenchProps = PanelProps & { notify: (message: string) => void; initialFile?: string | null; initialDiff?: string; initialTab?: string; sessionName?: string; sessions: Session[]; onAdd: (path: string, selection?: string) => void };
export default function ChangesPanel({ api, workspaceHash, onClose, notify, initialFile, initialDiff, initialTab = 'git', sessionName, sessions, onAdd }: WorkbenchProps) {
  const [tab, setTab] = useState(initialTab); const [revision, setRevision] = useState(0); const [file, setFile] = useState(initialFile || '');
  const [panelWidth, setPanelWidth] = useLocalState<number>('right-panel-width', DEFAULT_PANEL_WIDTH);
  const [dragging, setDragging] = useState(false);
  const [docked, setDocked] = useState(() => typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 1101px)').matches : true);
  const wide = panelWidth > DEFAULT_PANEL_WIDTH + 1;
  useEffect(() => { setTab(initialTab); }, [initialTab]);
  useEffect(() => { if (initialFile) { setFile(initialFile); setTab('git'); } }, [initialFile]);
  useEffect(() => { const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 1101px)') : null; if (!mq) return; const onChange = () => setDocked(mq.matches); onChange(); mq.addEventListener('change', onChange); return () => mq.removeEventListener('change', onChange); }, []);
  // Drag the panel's left edge to resize, mirroring legacy RightPanel.vue.
  function startResize(event: ReactMouseEvent<HTMLDivElement>) { event.preventDefault(); const startX = event.clientX; const startWidth = event.currentTarget.parentElement?.getBoundingClientRect().width || panelWidth; setDragging(true); const onMove = (move: MouseEvent) => setPanelWidth(resizePanelWidth(startWidth, move.clientX - startX, window.innerWidth)); const onUp = () => { setDragging(false); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); }; window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp); }
  const diff = useRemote<{ diff: string }>(api, file && tab === 'git' ? `/git/diff-content?${query({ workspaceHash, path: file })}` : null, revision);
  const refresh = () => setRevision(value => value + 1);
  return <aside className={`changes-panel ${wide ? 'wide' : ''}${dragging ? ' resizing' : ''}`} style={docked ? { width: panelWidth, flexBasis: panelWidth } : undefined} aria-label="工作区面板">{docked && <div className="panel-resize-handle" role="separator" aria-orientation="vertical" aria-label="拖动调整右侧面板宽度" title="拖动调整右侧面板宽度" onMouseDown={startResize} />}<header className="panel-header"><strong>工作区</strong><div><IconButton label="刷新工作区面板" onClick={refresh}><RefreshCw size={16} /></IconButton><IconButton label="展开工作区面板" onClick={() => setPanelWidth(wide ? DEFAULT_PANEL_WIDTH : WIDE_PANEL_WIDTH)}><Maximize size={16} /></IconButton><IconButton label="收起工作区面板" onClick={onClose}><X size={16} /></IconButton></div></header><div className="workbench-tabs" role="tablist" aria-label="工作区工具">{[['files', '文件'], ['git', 'Git'], ['schedules', '定时'], ['subagents', '子代理'], ['capabilities', '能力'], ['environment', '环境']].map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}</div><div className="workbench-body">{!workspaceHash ? <p className="panel-empty">请先选择工作区</p> : tab === 'files' ? <FilesPanel key={workspaceHash} {...{ api, workspaceHash, revision, onAdd }} /> : tab === 'git' ? <><GitTools key={workspaceHash} {...{ api, workspaceHash, revision }} onRefresh={refresh} onFile={setFile} />{file && <section className="workspace-preview workbench-card"><header><strong>{file}</strong><Button size="sm" variant="light" onPress={() => onAdd(file)}>引用文件</Button><Button size="sm" variant="light" onPress={() => setFile('')}>关闭</Button></header>{file === initialFile && initialDiff !== undefined ? <DiffView diff={initialDiff} /> : <><RemoteState {...diff} />{diff.data && <DiffView diff={diff.data.diff} />}</>}</section>}</> : tab === 'schedules' ? <SchedulePanel key={workspaceHash} {...{ api, workspaceHash, sessionName, sessions, revision }} onRefresh={refresh} /> : tab === 'subagents' ? <SubAgentsPanel key={`${workspaceHash}/${sessionName}`} {...{ api, workspaceHash, sessionName, notify }} onDiff={path => { setFile(path); setTab('git'); }} /> : tab === 'capabilities' ? <ProjectCapabilities key={workspaceHash} {...{ api, workspaceHash, notify }} workspaceName={sessions.find(item => item.workspaceHash === workspaceHash)?.workspace} /> : <Environment key={`${workspaceHash}/${sessionName}`} {...{ api, workspaceHash, sessionName, revision, notify }} onRefresh={refresh} />}</div></aside>;
}
function Environment({ api, workspaceHash, sessionName, revision, notify, onRefresh }: { api: LoopraClient; workspaceHash: string; sessionName?: string; revision: number; notify: (text: string) => void; onRefresh: () => void }) {
  const suffix = query({ workspaceHash, sessionName });
  const state = useRemote<Record<string, string | boolean>>(api, sessionName ? `/git/environment?${suffix}` : null, revision);
  const mode = useRemote<{ worktreeMode: boolean; mergeMode: string }>(api, sessionName ? `/sessions/${encodeURIComponent(sessionName)}/worktree?${query({ workspaceHash })}` : null, revision);
  const [busy, setBusy] = useState(false);
  async function act(path: string, method: string, body: unknown) { setBusy(true); try { await api.request(path, method, body); onRefresh(); } catch (cause) { notify(errorText(cause)); } finally { setBusy(false); } }
  if (!sessionName) return <p className="panel-empty">选择会话后可以管理隔离分支环境。</p>;
  return <><RemoteState {...state} /><RemoteState loading={mode.loading} error={mode.error} /><div className="workbench-card"><strong>当前会话环境</strong>{state.data && <><p>{String(state.data.currentPath || state.data.message || '尚未创建')}</p><p>{String(state.data.currentBranch || '')} · {state.data.currentDirty ? '有未提交改动' : '干净'}</p></>}<label className="workbench-actions"><input type="checkbox" disabled={busy || !!state.data?.agentRunning || !mode.data} checked={!!mode.data?.worktreeMode} onChange={event => void act(`/sessions/${encodeURIComponent(sessionName)}/worktree?${query({ workspaceHash })}`, 'PUT', { ...mode.data, worktreeMode: event.target.checked })} />隔离分支模式</label><p>合并方式</p><select aria-label="隔离分支合并方式" disabled={busy || !mode.data} value={mode.data?.mergeMode || 'manual'} onChange={event => void act(`/sessions/${encodeURIComponent(sessionName)}/worktree?${query({ workspaceHash })}`, 'PUT', { ...mode.data, mergeMode: event.target.value })}><option value="manual">手动</option><option value="ai-auto">AI 自动</option><option value="ai-auto-approve">AI 自动并审批</option></select><Button size="sm" variant="flat" isDisabled={busy || !!state.data?.worktreeExists || !mode.data?.worktreeMode} onPress={() => void act('/git/worktree/create', 'POST', { workspaceHash, sessionName })}>创建隔离分支</Button></div></>;
}
export function TerminalPanel({ api, workspaceHash, onClose, notify }: PanelProps & { initialShell?: string; notify?: (message: string) => void }) {
  const [sessions, setSessions] = useState<BashSession[]>([]);
  const [selected, setSelected] = useState('');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [copied, setCopied] = useState('');
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        if (!workspaceHash) return;
        const list = await api.request<BashSession[]>(bashSessionsPath(workspaceHash), 'GET', undefined, controller.signal);
        if (controller.signal.aborted) return;
        setSessions(list); setError('');
        const id = list.some(item => item.sessionId === selected) ? selected : list[0]?.sessionId;
        if (id) { setSelected(id); const log = await api.request<{ output: string }>(bashSessionLogPath(workspaceHash, id), 'GET', undefined, controller.signal); if (!controller.signal.aborted) setOutput(log.output); }
        else { setSelected(''); setOutput('暂无后台命令。你可以在聊天中让助手运行任务，后台命令的输出会显示在这里。'); }
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '读取失败'); }
    }
    void load(); const timer = setInterval(() => void load(), 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [api, workspaceHash, selected, revision]);
  async function copy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      notify?.('复制成功');
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(value => value === key ? '' : value), 1500);
    } catch (cause) { setError(errorText(cause)); }
  }
  async function terminate() {
    try { await api.request('/agent/bash-sessions/terminate', 'POST', { sessionId: selected, workspaceHash }); setRevision(value => value + 1); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '停止失败'); }
  }
  const current = sessions.find(item => item.sessionId === selected);
  return <section className="terminal-panel" aria-label="终端"><header><span><SquareTerminal size="1.0625rem" />后台进程</span><small className="terminal-summary">{bashSessionSummary(sessions)}</small>{current?.status === 'running' && <Button size="sm" color="danger" variant="light" onPress={() => void terminate()}>停止进程</Button>}<IconButton label="刷新终端" onClick={() => setRevision(value => value + 1)}><RefreshCw size="1rem" /></IconButton><IconButton label="关闭终端" onClick={onClose}><X size="1.0625rem" /></IconButton></header>
    {error && <p className="settings-error" role="alert">{error}</p>}
    <ul className="bash-list">{sessions.map(item => <li key={item.sessionId} className={`bash-row ${item.sessionId === selected ? 'selected' : ''}`}>
      <button type="button" className="bash-select" aria-label={`查看日志 ${item.sessionId}`} onClick={() => setSelected(item.sessionId)}><span className={`bash-dot ${item.status}`} aria-hidden="true" /></button>
      <div className="bash-main">
        <button type="button" className={`bash-copy bash-command ${copied === `${item.sessionId}:command` ? 'copied' : ''}`} title={copied === `${item.sessionId}:command` ? '已复制' : '点击复制命令'} onClick={() => void copy(`${item.sessionId}:command`, item.command)}><strong>{item.command}</strong></button>
        <div className="bash-meta"><span className={`bash-state ${item.status}`}>{bashSessionState(item)}</span><span>{formatBashUptime(item)}</span></div>
        {item.workdir && <button type="button" className={`bash-copy bash-workdir ${copied === `${item.sessionId}:workdir` ? 'copied' : ''}`} title={copied === `${item.sessionId}:workdir` ? '已复制' : '点击复制工作目录'} onClick={() => void copy(`${item.sessionId}:workdir`, item.workdir || '')}>{item.workdir}</button>}
      </div>
    </li>)}</ul>
    {sessions.length === 0 && <p className="panel-empty">暂无后台命令。你可以在聊天中让助手运行任务，后台命令的输出会显示在这里。</p>}
    <div className="terminal-output"><pre>{output}</pre></div>
  </section>;
}

