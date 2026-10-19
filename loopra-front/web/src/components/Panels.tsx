import { useEffect, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { Button } from '@nextui-org/react';
import { Bot, CalendarClock, Check, ChevronDown, FolderTree, GitBranch, Maximize, Puzzle, RefreshCw, SquareTerminal, X, type LucideIcon } from 'lucide-react';
import { IconButton } from './ui';
import { Popup } from './Motion';
import type { LoopraClient } from '../backend';
import type { Session } from '../lib';
import { useLocalState } from '../lib';
import { DEFAULT_PANEL_WIDTH, WIDE_PANEL_WIDTH, resizePanelWidth } from '../panel-resize';
import FilesPanel from './FilesPanel';
import GitTools from './GitTools';
import type { WorkspaceFile } from '../workspace-tabs';
import SchedulePanel from './SchedulePanel';
import SubAgentsPanel from './SubAgentsPanel';
import ProjectCapabilities from './ProjectCapabilities';
import EnvironmentPanel, { EnvironmentBar, useEnvironmentController } from './EnvironmentPanel';
import { bashSessionState, bashSessionSummary, formatBashUptime } from '../bash-sessions';
import { useBashSessions, type BashSessionsState } from '../useBashSessions';
import { watchWorkspaceChanges } from '../workspace-events';

type TabDef = [id: string, label: string, icon: LucideIcon];
const PRIMARY_TABS: TabDef[] = [['files', '文件', FolderTree], ['git', 'Git', GitBranch]];
const MORE_TABS: TabDef[] = [['schedules', '定时', CalendarClock], ['subagents', '子代理', Bot], ['capabilities', '能力', Puzzle]];

type PanelProps = { api: LoopraClient; workspaceHash: string; onClose: () => void };
type SubAgentItem = { subSessionId: string; name?: string; title?: string; task?: string };
type WorkbenchProps = PanelProps & { open: boolean; notify: (message: string) => void; onOpenFile: (file: WorkspaceFile) => void; activeFile?: string | null; onPathChange?: (from: string, to?: string) => void; initialTab?: string; sessionName?: string; sessions: Session[]; onAdd: (path: string, selection?: string) => void; onOpenSubAgent?: (item: SubAgentItem) => void };
export default function ChangesPanel({ open, api, workspaceHash, onClose, notify, onOpenFile, activeFile, onPathChange, initialTab = 'git', sessionName, sessions, onAdd, onOpenSubAgent }: WorkbenchProps) {
  const [tab, setTab] = useState(initialTab); const [revision, setRevision] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = MORE_TABS.find(([id]) => id === tab);
  useEffect(() => {
    if (!moreOpen) return undefined;
    const close = (event: Event) => { if (!(event.target as Element | null)?.closest?.('[data-popover]')) setMoreOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMoreOpen(false); };
    document.addEventListener('pointerdown', close); window.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); window.removeEventListener('keydown', escape); };
  }, [moreOpen]);
  useEffect(() => watchWorkspaceChanges(workspaceHash, () => setRevision(value => value + 1)), [workspaceHash]);
  const [panelWidth, setPanelWidth] = useLocalState<number>('right-panel-width', DEFAULT_PANEL_WIDTH);
  const [dragging, setDragging] = useState(false);
  const [docked, setDocked] = useState(() => typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 1101px)').matches : true);
  const wide = panelWidth > DEFAULT_PANEL_WIDTH + 1;
  useEffect(() => { setTab(initialTab); }, [initialTab]);
  useEffect(() => { const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 1101px)') : null; if (!mq) return; const onChange = () => setDocked(mq.matches); onChange(); mq.addEventListener('change', onChange); return () => mq.removeEventListener('change', onChange); }, []);
  // Drag the panel's left edge to resize, mirroring legacy RightPanel.vue.
  function startResize(event: ReactMouseEvent<HTMLDivElement>) { event.preventDefault(); const startX = event.clientX; const startWidth = event.currentTarget.parentElement?.getBoundingClientRect().width || panelWidth; setDragging(true); const onMove = (move: MouseEvent) => setPanelWidth(resizePanelWidth(startWidth, move.clientX - startX, window.innerWidth)); const onUp = () => { setDragging(false); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); }; window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp); }
  const refresh = () => setRevision(value => value + 1);
  // `--panel-width` is what the slide collapses to when closed (see `.changes-panel`
  // in styles.css); it tracks the resize handle because the inline width overrides
  // the static one.
  return <aside className={`changes-panel ${wide ? 'wide' : ''}${dragging ? ' resizing' : ''}`} data-open={open} style={docked ? ({ width: panelWidth, flexBasis: panelWidth, '--panel-width': `${panelWidth}px` } as CSSProperties) : undefined} aria-label="工作区面板">
    {docked && <div className="panel-resize-handle" role="separator" aria-orientation="vertical" aria-label="拖动调整右侧面板宽度" title="拖动调整右侧面板宽度" onMouseDown={startResize} />}
    <header className="panel-header">
      <div className="workbench-tabs" role="tablist" aria-label="工作区工具">
        {PRIMARY_TABS.map(([id, label, Icon]) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}><Icon size={14} />{label}</button>)}
        <div data-popover className="menu-anchor">
          <button role="tab" aria-selected={!!moreActive} aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen(open => !open)}>{moreActive ? moreActive[1] : '更多'}<ChevronDown size={13} /></button>
          <Popup open={moreOpen} className="popup panel-more-menu" role="menu">{MORE_TABS.map(([id, label, Icon]) => <button key={id} role="menuitem" className={tab === id ? 'chosen' : ''} onClick={() => { setTab(id); setMoreOpen(false); }}><Icon size={15} />{label}{tab === id && <Check size={14} />}</button>)}</Popup>
        </div>
      </div>
      <div className="panel-actions"><IconButton label="刷新工作区面板" onClick={refresh}><RefreshCw size={15} /></IconButton><IconButton label="展开工作区面板" onClick={() => setPanelWidth(wide ? DEFAULT_PANEL_WIDTH : WIDE_PANEL_WIDTH)}><Maximize size={15} /></IconButton><IconButton label="收起工作区面板" onClick={onClose}><X size={16} /></IconButton></div>
    </header>
    <div className="workbench-body" data-tab={tab}>{!workspaceHash ? <p className="panel-empty">请先选择工作区</p> : tab === 'files' ? <FilesPanel key={workspaceHash} {...{ api, workspaceHash, revision, onAdd }} activePath={activeFile} onPathChange={onPathChange} onOpen={path => onOpenFile({ path, mode: 'content' })} /> : tab === 'git' ? <GitWorkspace key={`${workspaceHash}/${sessionName}`} {...{ api, workspaceHash, sessionName, revision, notify }} onRefresh={refresh} onOpenFile={onOpenFile} /> : tab === 'schedules' ? <SchedulePanel key={workspaceHash} {...{ api, workspaceHash, sessionName, sessions, revision }} onRefresh={refresh} /> : tab === 'subagents' ? <SubAgentsPanel key={`${workspaceHash}/${sessionName}`} {...{ api, workspaceHash, sessionName, notify }} onDiff={path => onOpenFile({ path, mode: 'diff' })} onOpenTab={onOpenSubAgent} /> : tab === 'capabilities' ? <ProjectCapabilities key={workspaceHash} {...{ api, workspaceHash, notify }} workspaceName={sessions.find(item => item.workspaceHash === workspaceHash)?.workspace} /> : <p className="panel-empty">未知的工作区工具。</p>}</div></aside>;
}
// Git and the session environment share one tab: the environment strip states
// which checkout is active, and isolation mode swaps the main-project Git tools
// for the worktree-specific view (commits/history target the worktree).
function GitWorkspace({ api, workspaceHash, sessionName, revision, notify, onRefresh, onOpenFile }: Omit<PanelProps, 'onClose'> & { sessionName?: string; revision: number; notify: (message: string) => void; onRefresh: () => void; onOpenFile: (file: WorkspaceFile) => void }) {
  const controller = useEnvironmentController({ api, workspaceHash, sessionName, revision, notify, onRefresh });
  // While a session's checkout is still unknown, never fall back to the main
  // project's Git tools: that would let the user commit the wrong working tree.
  const unknownSessionCheckout = !!sessionName && (!controller.environment || (!controller.mode && (controller.loading || controller.loadError)));
  return <>
    <EnvironmentBar controller={controller} />
    {unknownSessionCheckout || controller.mode?.worktreeMode
      ? <EnvironmentPanel controller={controller} onFile={path => onOpenFile({ path, mode: 'diff', environment: sessionName })} onMainFile={path => onOpenFile({ path, mode: 'diff' })} />
      : <GitTools key={workspaceHash} {...{ api, workspaceHash, revision, notify }} showBranch={false} onRefresh={onRefresh} onFile={path => onOpenFile({ path, mode: 'diff' })} />}
  </>;
}
export function TerminalPanel({ api, workspaceHash, onClose, state, onInspect }: PanelProps & { notify?: (message: string) => void; state?: BashSessionsState; onInspect?: (id: string) => void }) {
  const localState = useBashSessions(api, workspaceHash, !state);
  const data = state || localState;
  const { sessions, selected, output, loading } = data;
  const [actionError, setError] = useState('');
  const error = actionError || data.error;
  async function terminate(id: string) {
    try { await data.terminate(id); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '停止失败'); }
  }
  function inspect(id: string) { data.select(id); onInspect?.(id); }
  return <section className="terminal-panel" aria-label="终端"><header><span><SquareTerminal size="1.0625rem" />后台进程</span><small className="terminal-summary">{bashSessionSummary(sessions)}</small><IconButton label="刷新终端" onClick={data.refresh}><RefreshCw size="1rem" /></IconButton><IconButton label="关闭终端" onClick={onClose}><X size="1.0625rem" /></IconButton></header>
    {error && <p className="settings-error" role="alert">{error}</p>}
    <ul className="bash-list">{sessions.map(item => <li key={item.sessionId} className={`bash-row ${item.sessionId === selected ? 'selected' : ''}`}>
      <button type="button" className="bash-select bash-command" aria-label={`查看日志 ${item.sessionId}`} title="查看任务输出" onClick={() => inspect(item.sessionId)}>
        <span className={`bash-dot ${item.status}`} aria-hidden="true" />
        <span className="bash-main"><strong>{item.command}</strong>
          <span className="bash-meta"><span className={`bash-state ${item.status}`}>{bashSessionState(item)}</span><span>{formatBashUptime(item)}</span></span>
          {item.workdir && <span className="bash-workdir">{item.workdir}</span>}
        </span>
      </button>
      <div className="bash-task-actions">{item.status === 'running' ? <Button className="bash-terminate" size="sm" color="danger" variant="light" aria-label={`终止任务 ${item.sessionId}`} isLoading={data.terminating.includes(item.sessionId)} onPress={() => void terminate(item.sessionId)}>终止</Button> : <span>已结束</span>}</div>
    </li>)}</ul>
    {sessions.length === 0 && <p className="panel-empty">{loading ? '正在读取后台任务…' : '暂无后台命令。你可以在聊天中让助手运行任务，后台命令的输出会显示在这里。'}</p>}
    {sessions.length > 0 && !onInspect && <div className="terminal-output"><pre>{output ?? (loading ? '正在读取输出…' : '暂时没有输出。')}</pre></div>}
  </section>;
}

