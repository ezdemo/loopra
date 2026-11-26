import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, CopyMinus, CopyPlus, FolderClosed, FolderOpen, FolderPlus, MessageCirclePlus, MessageSquare, MoreHorizontal, PanelLeft, Pencil, Plus, RefreshCw, Terminal, Trash2 } from 'lucide-react';
import { IconButton, LoadingSkeleton } from '../components/ui';
import { Collapse, SelectionIndicator, SidebarSurface } from '../components/Motion';
import { useLocalState, type Session } from '../lib';
import type { Workspace } from '../backend';
import { sessionDate } from '../session-order';
import { DEFAULT_SIDEBAR_WIDTH, clampSidebarWidth, resizeSidebarWidth } from '../panel-resize';
import AgentIcon, { PersonaIcon } from '../components/AgentIcon';

/** Sessions a project shows before the list folds behind "展开显示". */
const SESSION_GROUP_LIMIT = 6;

function SessionListSkeleton() {
  const { t } = useTranslation();
  return <div className="sidebar-loading-sessions" role="status" aria-label={t('nav.loadingSessions')}>{[0, 1, 2, 3].map(row => <div className="sidebar-loading-row" key={row}><LoadingSkeleton className="skeleton-session-title" /><LoadingSkeleton className="skeleton-session-time" /></div>)}</div>;
}

export type SidebarProps = {
  /** Drives the slide; the element stays mounted while it closes (see `usePresence`). */
  open: boolean;
  workspaces: Workspace[];
  sessions: Session[];
  workspacesLoading?: boolean;
  sessionsLoading?: boolean;
  runningIds?: ReadonlySet<string>;
  unreadIds?: ReadonlySet<string>;
  activeId: string;
  workspace: string;
  isHome: boolean;
  /** Workspace hashes the user has opened. Missing hashes stay folded on first entry. */
  expanded: string[];
  onExpanded: (next: string[] | ((current: string[]) => string[])) => void;
  onClose: () => void;
  onNewSession: (workspaceHash?: string) => void;
  onRefreshAll: () => void;
  onRefreshProject: (hash: string) => void;
  onRefreshSession: (session: Session) => void;
  onManageProject: (workspace: Workspace) => void;
  /** Opens the project manager dialog from the 项目 section header. */
  onManageProjects: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (session: Session) => void;
  onReorder: (from: string, to: string) => void;
  onReorderSessions: (workspaceHash: string, fromId: string, toId: string) => void;
  /** 打开新建/编辑自定义智能体对话框。 */
  onNewAgent?: () => void;
  onEditAgent?: (workspace: Workspace) => void;
};

/**
 * Session titles stay clipped while idle; on hover a clipped one slides sideways
 * so the whole name can be read without widening the sidebar.
 */
function SessionTitle({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [distance, setDistance] = useState(0);
  const measure = () => {
    const node = ref.current;
    const box = node?.parentElement;
    if (!node || !box) return;
    setDistance(Math.max(0, Math.ceil(node.scrollWidth - box.clientWidth)));
  };
  return <span className={`session-title${distance > 0 ? ' marquee' : ''}`}
    style={{ '--marquee-distance': `-${distance}px`, '--marquee-duration': `${Math.max(2, Math.round(distance / 40))}s` } as CSSProperties}>
    <span ref={ref} onMouseEnter={measure}>{text}</span>
  </span>;
}

export default function Sidebar(props: SidebarProps) {
  const { workspaces, sessions, activeId, workspace, isHome, expanded, onExpanded } = props;
  const { t } = useTranslation();
  const [dragging, setDragging] = useState('');
  const [dragOver, setDragOver] = useState('');
  const [draggingSession, setDraggingSession] = useState('');
  const [dragOverSession, setDragOverSession] = useState('');
  const [expandedGroups, setExpandedGroups] = useLocalState<string[]>('expanded-session-groups', []);
  const [collapsedSections, setCollapsedSections] = useLocalState<string[]>('sidebar-collapsed-sections', []);
  const [sidebarWidth, setSidebarWidth] = useLocalState<number>('sidebar-width', DEFAULT_SIDEBAR_WIDTH);
  const [resizing, setResizing] = useState(false);
  // A narrower window must not leave a stored wide sidebar covering the chat.
  useEffect(() => {
    const onResize = () => setSidebarWidth(current => clampSidebarWidth(current, window.innerWidth));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [setSidebarWidth]);
  function startResize(event: React.MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = event.currentTarget.parentElement?.getBoundingClientRect().width || sidebarWidth;
    setResizing(true);
    document.body.style.cursor = 'col-resize';
    const onMove = (move: MouseEvent) => setSidebarWidth(resizeSidebarWidth(startWidth, move.clientX - startX, window.innerWidth));
    const onUp = () => { setResizing(false); document.body.style.cursor = ''; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }
  const agentWorkspaces = workspaces.filter(item => item.kind === 'chat' || item.kind === 'agent');
  const projectWorkspaces = workspaces.filter(item => item.kind === 'project' || !item.kind);
  const sections = [
    { id: 'agents', title: t('nav.agents'), items: agentWorkspaces },
    { id: 'projects', title: t('nav.projects'), items: projectWorkspaces },
  ];
  const allCollapsed = projectWorkspaces.length > 0 && projectWorkspaces.every(item => !expanded.includes(item.hash));
  const toggleProjects = () => onExpanded(current => {
    const other = current.filter(hash => !projectWorkspaces.some(item => item.hash === hash));
    return allCollapsed ? [...other, ...projectWorkspaces.map(item => item.hash)] : other;
  });
  const toggle = (hash: string) => onExpanded(current => current.includes(hash) ? current.filter(item => item !== hash) : [...current, hash]);
  const toggleExpanded = (hash: string) => setExpandedGroups(current => current.includes(hash) ? current.filter(item => item !== hash) : [...current, hash]);
  const toggleSection = (id: string) => setCollapsedSections(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  const sessionWorkspace = (id: string) => sessions.find(entry => entry.id === id)?.workspaceHash;
  // A session opened from search may sit below the fold; make sure its group
  // shows the whole list rather than hiding the row that is currently selected.
  useEffect(() => {
    if (!activeId) return;
    const active = sessions.find(entry => entry.id === activeId);
    const hash = active?.workspaceHash;
    if (!hash) return;
    const own = sessions.filter(entry => entry.workspaceHash === hash);
    if (own.findIndex(entry => entry.id === activeId) < SESSION_GROUP_LIMIT) return;
    setExpandedGroups(current => current.includes(hash) ? current : [...current, hash]);
  }, [activeId, sessions, setExpandedGroups]);

  function groupProps(hash: string, locked = false) {
    return {
      draggable: !locked,
      onDragStart: (event: React.DragEvent) => { if (locked) { event.preventDefault(); return; } setDragging(hash); event.dataTransfer.effectAllowed = 'move'; },
      onDragOver: (event: React.DragEvent) => {
        if (locked || !dragging || dragging === hash) return;
        event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragOver(hash);
      },
      onDragLeave: () => setDragOver(current => current === hash ? '' : current),
      onDrop: (event: React.DragEvent) => { if (locked || !dragging || dragging === hash) return; event.preventDefault(); props.onReorder(dragging, hash); },
      onDragEnd: () => { setDragging(''); setDragOver(''); },
    };
  }

  return <SidebarSurface key="sidebar" open={props.open} width={sidebarWidth}>
    <div className={`sidebar-resize-handle${resizing ? ' resizing' : ''}`} role="separator" aria-orientation="vertical"
      aria-label={t('nav.resizeSidebar')} title={t('nav.resizeSidebar')} onMouseDown={startResize} />
    <div className="sidebar-brand">
      <span>Loopra</span>
      <IconButton label={t('nav.collapseSidebar')} onClick={props.onClose}><PanelLeft size="1rem" /></IconButton>
    </div>
    <div className="sidebar-actions">
      <button onClick={() => props.onNewSession()}><MessageCirclePlus />{t('nav.newChat')}</button>
    </div>
    <div className="session-section">
      {sections.map(section => <section key={section.id} className="sidebar-section" aria-label={section.title}>
        <div className="section-label">
          <button type="button" className="sidebar-section-toggle" aria-expanded={!collapsedSections.includes(section.id)} aria-controls={`sidebar-${section.id}`} onClick={() => toggleSection(section.id)}>
            <svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="m4 2 4 4-4 4Z" /></svg><span>{section.title}</span>
          </button>
          {section.id === 'agents' && <div>
            <IconButton label={t('nav.newAgent')} onClick={() => props.onNewAgent?.()}><Plus size="0.875rem" /></IconButton>
          </div>}
          {section.id === 'projects' && <div>
            <IconButton label={t('nav.addProject')} onClick={props.onManageProjects}><FolderPlus size="0.875rem" /></IconButton>
            <IconButton label={allCollapsed ? t('nav.expandAllWorkspaces') : t('nav.collapseAllWorkspaces')} onClick={toggleProjects}>{allCollapsed ? <CopyPlus size="0.875rem" /> : <CopyMinus size="0.875rem" />}</IconButton>
            <IconButton label={t('nav.refreshProjects')} onClick={() => void props.onRefreshAll()}><RefreshCw size="0.875rem" /></IconButton>
          </div>}
        </div>
        <Collapse open={!collapsedSections.includes(section.id)} id={`sidebar-${section.id}`}>
        {props.workspacesLoading ? <div className="sidebar-loading-workspaces" aria-label={t('nav.loadingGroup', { group: section.title.toLowerCase() })} aria-busy="true">{(section.id === 'agents' ? [0] : [0, 1, 2]).map(group => <div className="sidebar-loading-group" key={group}><div className="sidebar-loading-heading"><LoadingSkeleton className="skeleton-workspace-icon" /><LoadingSkeleton className="skeleton-workspace-title" /></div><SessionListSkeleton /></div>)}</div> : section.items.map(item => {
          const open = expanded.includes(item.hash);
          const own = sessions.filter(entry => entry.workspaceHash === item.hash);
          const showAll = expandedGroups.includes(item.hash);
          const shown = showAll ? own : own.slice(0, SESSION_GROUP_LIMIT);
          const foldable = own.length > SESSION_GROUP_LIMIT;
          const chat = item.kind === 'chat';
          const agent = item.kind === 'agent';
          const locked = chat || agent;
          return <div key={item.hash} className={`workspace-group ${dragging === item.hash ? 'dragging' : ''} ${dragOver === item.hash && dragging !== item.hash ? 'drag-over' : ''}`} {...groupProps(item.hash, locked)}>
            <div className="workspace-heading-row">
              <button type="button" title={item.path || (agent ? (item.agent?.projectHash ? `${t('nav.boundTo')}: ${workspaces.find(entry => entry.hash === item.agent?.projectHash)?.name || item.agent.projectHash}` : t('nav.noProject')) : chat ? t('nav.noProject') : item.name)} className={`workspace-heading ${isHome && workspace === item.hash ? 'selected' : ''}`} aria-label={`${open ? t('nav.collapse') : t('nav.expand')} ${item.name}`} aria-expanded={open} onClick={() => toggle(item.hash)}>
                <ChevronRight className="workspace-chevron" />{agent ? <PersonaIcon icon={item.agent?.icon} className="workspace-chat-icon" size="0.875rem" /> : chat ? <MessageSquare className="workspace-chat-icon" aria-hidden="true" /> : open ? <FolderOpen /> : <FolderClosed />}<span>{item.name}</span>
              </button>
              <span className="workspace-tools">
                <IconButton label={t('nav.newSessionIn', { name: item.name })} onClick={() => props.onNewSession(item.hash)}><Plus size="0.8125rem" /></IconButton>
                <IconButton label={t('nav.refreshSessionsIn', { name: item.name })} onClick={() => props.onRefreshProject(item.hash)}><RefreshCw size="0.8125rem" /></IconButton>
                <IconButton label={t('nav.manageSessionsIn', { name: item.name })} onClick={() => props.onManageProject(item)}><MoreHorizontal size="0.9375rem" /></IconButton>
                {agent && <IconButton label={t('nav.editAgent', { name: item.name })} onClick={() => props.onEditAgent?.(item)}><Pencil size="0.8125rem" /></IconButton>}
              </span>
            </div>
            <Collapse open={open} className="workspace-sessions">
              {!own.length && (props.sessionsLoading ? <SessionListSkeleton /> : <p className="no-conversation">{t('nav.noConversations')}</p>)}
              {shown.map(entry => <div key={entry.id} data-session-key={entry.id} draggable
                onDragStart={event => {
                  // A session drag must not start the project drag on the parent row.
                  event.stopPropagation(); event.dataTransfer.effectAllowed = 'move';
                  setDragging(''); setDragOver(''); setDraggingSession(entry.id);
                }}
                onDragOver={event => {
                  if (!draggingSession || draggingSession === entry.id || sessionWorkspace(draggingSession) !== item.hash) return;
                  event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
                  setDragOverSession(entry.id);
                }}
                onDragLeave={() => setDragOverSession(current => current === entry.id ? '' : current)}
                onDrop={event => {
                  if (!draggingSession || sessionWorkspace(draggingSession) !== item.hash) return;
                  event.preventDefault(); event.stopPropagation();
                  props.onReorderSessions(item.hash, draggingSession, entry.id);
                  setDraggingSession(''); setDragOverSession('');
                }}
                onDragEnd={() => { setDraggingSession(''); setDragOverSession(''); }}
                className={`session-row ${activeId === entry.id ? 'selected' : ''}${draggingSession === entry.id ? ' dragging' : ''}${dragOverSession === entry.id && draggingSession !== entry.id ? ' drag-over' : ''}`}>
                <button className={`session-item ${activeId === entry.id ? 'selected' : ''}`} onClick={() => props.onSelectSession(entry.id)}
                  title={entry.customAgentId ? `${entry.title} · ${workspaces.find(ws => ws.hash === entry.customAgentId)?.name || t('nav.customAgent')}` : entry.title}>
                  {activeId === entry.id && <SelectionIndicator />}
                  {entry.customAgentId ? <PersonaIcon icon={workspaces.find(ws => ws.hash === entry.customAgentId)?.agent?.icon} size="0.875rem" /> : <AgentIcon agentId={entry.agentId || 'native'} />}
                  <SessionTitle text={entry.title} />
                  {props.runningIds?.has(entry.id) ? <span className="session-run-indicator running" role="img" aria-label={t('nav.running')} title={t('nav.running')} /> : props.unreadIds?.has(entry.id) && <span className="session-run-indicator" role="img" aria-label={t('nav.newReply')} title={t('nav.newReply')} />}
                  {entry.mode === 'tui' && <Terminal className="session-tui-badge" size="0.75rem" aria-label={t('nav.tuiSession')} />}
                  {entry.worktreeMode && <i className="wt-badge" title={t('nav.worktreeMode')}>🌲</i>}
                  <time>{sessionDate(entry.mtime)}</time>
                </button>
                <span className="session-row-tools">
                  <IconButton label={t('nav.refreshSession', { title: entry.title })} onClick={() => props.onRefreshSession(entry)}><RefreshCw size="0.75rem" /></IconButton>
                  <IconButton label={t('nav.deleteSession', { title: entry.title })} onClick={() => props.onDeleteSession(entry)}><Trash2 size="0.75rem" /></IconButton>
                </span>
              </div>)}
              {foldable && <button type="button" className="session-more" aria-expanded={showAll}
                title={t('nav.sessionCount', { count: own.length })} onClick={() => toggleExpanded(item.hash)}>
                {showAll ? t('nav.showLess') : t('nav.showMore')}
              </button>}
            </Collapse>
          </div>;
        })}
        </Collapse>
      </section>)}
    </div>
  </SidebarSurface>;
}
