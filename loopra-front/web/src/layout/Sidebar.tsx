import { useState, type RefObject } from 'react';
import { ChevronRight, Crosshair, FolderClosed, FolderOpen, FoldVertical, MessageCirclePlus, MoreHorizontal, PanelLeft, Plus, RefreshCw, Search as SearchIcon, Settings as SettingsIcon, SlidersHorizontal, Trash2, UnfoldVertical } from 'lucide-react';
import { IconButton, LoopraMark } from '../components/ui';
import { Collapse, SelectionIndicator, SidebarSurface } from '../components/Motion';
import type { Session } from '../lib';
import type { Workspace } from '../backend';

export type SidebarProps = {
  english: boolean;
  workspaces: Workspace[];
  sessions: Session[];
  activeId: string;
  workspace: string;
  isHome: boolean;
  collapsed: string[];
  onCollapsed: (next: string[] | ((current: string[]) => string[])) => void;
  sortNewest: boolean;
  onSortNewest: (next: boolean) => void;
  sectionRef: RefObject<HTMLDivElement>;
  onClose: () => void;
  onNewSession: (workspaceHash?: string) => void;
  onSearch: () => void;
  onSettings: () => void;
  onLocate: () => void;
  onRefreshAll: () => void;
  onRefreshProject: (hash: string) => void;
  onRefreshSession: (session: Session) => void;
  onManageProject: (workspace: Workspace) => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (session: Session) => void;
  onReorder: (from: string, to: string) => void;
};

function sessionDate(mtime?: number) {
  return mtime ? new Date(mtime).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : '';
}

export default function Sidebar(props: SidebarProps) {
  const { english, workspaces, sessions, activeId, workspace, isHome, collapsed, onCollapsed, sortNewest } = props;
  const [dragging, setDragging] = useState('');
  const [dragOver, setDragOver] = useState('');
  const allCollapsed = workspaces.length > 0 && workspaces.every(item => collapsed.includes(item.hash));
  const toggle = (hash: string) => onCollapsed(current => current.includes(hash) ? current.filter(item => item !== hash) : [...current, hash]);

  function groupProps(hash: string) {
    return {
      draggable: true,
      onDragStart: (event: React.DragEvent) => { setDragging(hash); event.dataTransfer.effectAllowed = 'move'; },
      onDragOver: (event: React.DragEvent) => {
        if (!dragging || dragging === hash) return;
        event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragOver(hash);
      },
      onDragLeave: () => setDragOver(current => current === hash ? '' : current),
      onDrop: (event: React.DragEvent) => { event.preventDefault(); props.onReorder(dragging, hash); },
      onDragEnd: () => { setDragging(''); setDragOver(''); },
    };
  }

  return <SidebarSurface key="sidebar">
    <div className="sidebar-brand">
      <span className="app-icon"><LoopraMark small /></span><span>Loopra</span>
      <IconButton label="收起侧边栏" onClick={props.onClose}><PanelLeft size="1rem" /></IconButton>
    </div>
    <div className="sidebar-actions">
      <button onClick={() => props.onNewSession()}><MessageCirclePlus />{english ? 'New chat' : '新建会话'}</button>
      <button onClick={props.onSearch}><SearchIcon />{english ? 'Search' : '搜索'}</button>
    </div>
    <div className="session-section" ref={props.sectionRef}>
      <div className="section-label">
        <span>会话</span>
        <div>
          <IconButton label="定位当前会话" onClick={props.onLocate}><Crosshair size="0.875rem" /></IconButton>
          <IconButton label={allCollapsed ? '展开全部工作区' : '折叠全部工作区'} onClick={() => onCollapsed(allCollapsed ? [] : workspaces.map(item => item.hash))}>{allCollapsed ? <UnfoldVertical size="0.9375rem" /> : <FoldVertical size="0.9375rem" />}</IconButton>
          <IconButton label={sortNewest ? '恢复默认排序' : '按最新排序'} active={sortNewest} onClick={() => props.onSortNewest(!sortNewest)}><SlidersHorizontal size="0.875rem" /></IconButton>
          <IconButton label="刷新项目列表" onClick={() => void props.onRefreshAll()}><RefreshCw size="0.875rem" /></IconButton>
        </div>
      </div>
      {workspaces.map(item => {
        const open = !collapsed.includes(item.hash);
        const own = sessions.filter(entry => entry.workspaceHash === item.hash);
        const ordered = sortNewest ? [...own].reverse() : own;
        return <div key={item.hash} className={`workspace-group ${dragging === item.hash ? 'dragging' : ''} ${dragOver === item.hash && dragging !== item.hash ? 'drag-over' : ''}`} {...groupProps(item.hash)}>
          <div className="workspace-heading-row">
            <button type="button" title={item.path || item.name} className={`workspace-heading ${isHome && workspace === item.hash ? 'selected' : ''}`} aria-label={`${open ? '折叠' : '展开'} ${item.name}`} aria-expanded={open} onClick={() => toggle(item.hash)}>
              <ChevronRight className="workspace-chevron" />{open ? <FolderOpen /> : <FolderClosed />}<span>{item.name}</span>
            </button>
            <span className="workspace-tools">
              <IconButton label={`在 ${item.name} 新建会话`} onClick={() => props.onNewSession(item.hash)}><Plus size="0.8125rem" /></IconButton>
              <IconButton label={`刷新 ${item.name} 的会话`} onClick={() => props.onRefreshProject(item.hash)}><RefreshCw size="0.8125rem" /></IconButton>
              <IconButton label={`管理 ${item.name} 的会话`} onClick={() => props.onManageProject(item)}><MoreHorizontal size="0.9375rem" /></IconButton>
            </span>
          </div>
          <Collapse open={open} className="workspace-sessions">
            {!own.length && <p className="no-conversation">暂无对话</p>}
            {ordered.map(entry => <div key={entry.id} data-session-key={entry.id} className={`session-row ${activeId === entry.id ? 'selected' : ''}`}>
              <button className={`session-item ${activeId === entry.id ? 'selected' : ''}`} onClick={() => props.onSelectSession(entry.id)} title={entry.title}>
                {activeId === entry.id && <SelectionIndicator />}
                <span>{entry.title}</span>
                {entry.worktreeMode && <i className="wt-badge" title="隔离分支模式">🌲</i>}
                <time>{sessionDate(entry.mtime)}</time>
              </button>
              <span className="session-row-tools">
                <IconButton label={`刷新 ${entry.title}`} onClick={() => props.onRefreshSession(entry)}><RefreshCw size="0.75rem" /></IconButton>
                <IconButton label={`删除 ${entry.title}`} onClick={() => props.onDeleteSession(entry)}><Trash2 size="0.75rem" /></IconButton>
              </span>
            </div>)}
          </Collapse>
        </div>;
      })}
    </div>
    <footer className="sidebar-footer">
      <button type="button" className="sidebar-settings" aria-label="设置" onClick={props.onSettings}><SettingsIcon /><span>{english ? 'Settings' : '设置'}</span></button>
    </footer>
  </SidebarSurface>;
}
