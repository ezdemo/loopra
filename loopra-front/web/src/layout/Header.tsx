import { Archive, Check, ChevronDown, Copy, Download, FileCode2, FolderClosed, GitBranch, MessageCirclePlus, MoreHorizontal, PanelLeft, PanelRight, ScrollText, SquareTerminal, Trash2 } from 'lucide-react';
import { IconButton } from '../components/ui';
import { Popup } from '../components/Motion';
import type { Session } from '../lib';

export type HeaderProps = {
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  isHome: boolean;
  workspaceName: string;
  session?: Session;
  menu: string | null;
  onToggleMenu: (name: string) => void;
  backend: { status: 'connecting' | 'connected' | 'error'; ready: boolean; error: string; version: string };
  server: string;
  onStatus: () => void;
  gitBranch: string;
  changesOpen: boolean;
  onToggleChanges: () => void;
  applications: { application: string; name: string; label: string }[];
  onOpenWorkspace: (application?: string) => void;
  onCopyPath: () => void;
  onRename: () => void;
  onRecords: () => void;
  onClear: () => void;
  onExport: () => void;
  onHide: () => void;
  onDelete: () => void;
  onCopyTitle: () => void;
  onShowChanges: () => void;
};

function statusLabel(backend: HeaderProps['backend']) {
  if (backend.status === 'connecting') return '连接中';
  if (backend.status === 'error') return '连接失败';
  return backend.ready ? 'Loopra 已连接' : '需要配置模型';
}

export default function Header(p: HeaderProps) {
  const { session, menu, backend } = p;
  return <header className={`conversation-header ${p.isHome ? 'home-header' : ''}`}>
    {!p.sidebarOpen && <IconButton label="展开侧边栏" className="sidebar-reopen" onClick={p.onOpenSidebar}><PanelLeft size="1.0625rem" /></IconButton>}
    {!p.isHome && session && <div className="breadcrumb">
      <span>{p.workspaceName}</span><span className="breadcrumb-divider">/</span><strong title={session.title}>{session.title}</strong>
      <div data-popover className="menu-anchor">
        <IconButton label="会话选项" onClick={() => p.onToggleMenu('session')}><MoreHorizontal size="1rem" /></IconButton>
        <Popup open={menu === 'session'} className="popup session-menu" role="menu">
          <button role="menuitem" onClick={p.onRename}><FileCode2 size="1rem" />重命名会话</button>
          <button role="menuitem" onClick={p.onRecords}><ScrollText size="1rem" />会话记录</button>
          <button role="menuitem" onClick={p.onClear}><MessageCirclePlus size="1rem" />清空当前对话</button>
          <button role="menuitem" onClick={p.onExport}><Download size="1rem" />导出对话</button>
          <button role="menuitem" onClick={p.onHide}><Archive size="1rem" />在本机隐藏</button>
          <button role="menuitem" onClick={p.onDelete}><Trash2 size="1rem" />删除会话</button>
          <button role="menuitem" onClick={p.onCopyTitle}><Copy size="1rem" />复制会话标题</button>
        </Popup>
      </div>
    </div>}
    <div className="header-actions">
      <button className={`backend-status ${backend.status} ${backend.status === 'connected' && backend.ready ? 'is-ok' : ''}`} title={backend.error || `${statusLabel(backend)} · ${p.server} · v${backend.version}`} onClick={p.onStatus}><span />{statusLabel(backend)}</button>
      {!p.isHome && <>
        <div data-popover className="menu-anchor">
          <div className="folder-split">
            <button aria-label="在系统应用中打开项目" onClick={() => p.onOpenWorkspace()}><FolderClosed /></button>
            <button aria-label="打开方式" onClick={() => p.onToggleMenu('folder')}><ChevronDown /></button>
          </div>
          <Popup open={menu === 'folder'} className="popup folder-menu" role="menu">
            {p.applications.map(item => <button key={item.application} role="menuitem" onClick={() => p.onOpenWorkspace(item.name)}>{item.application === 'folder' ? <FolderClosed size="1rem" /> : <SquareTerminal size="1rem" />}{item.label}</button>)}
            <hr />
            <button role="menuitem" onClick={p.onCopyPath}><Copy size="1rem" />复制路径</button>
          </Popup>
        </div>
        {!p.changesOpen && <div data-popover className="menu-anchor">
          <button className="branch-button" onClick={() => p.onToggleMenu('branch')}><GitBranch />{p.gitBranch}</button>
          <Popup open={menu === 'branch'} className="popup branch-menu"><h3>当前分支</h3><button onClick={p.onShowChanges}><GitBranch size="0.9375rem" />{p.gitBranch}<Check size="1rem" /></button></Popup>
        </div>}
      </>}
      <IconButton label={p.changesOpen ? '关闭改动面板' : '打开改动面板'} active={p.changesOpen} onClick={p.onToggleChanges}><PanelRight size="1.0625rem" /></IconButton>
    </div>
  </header>;
}
