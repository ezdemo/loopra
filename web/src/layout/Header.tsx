import { Check, ChevronDown, Copy, Download, FileCode2, FolderClosed, GitBranch, MessageCirclePlus, MoreHorizontal, PanelLeft, PanelRight, ScrollText, SquareTerminal, Trash2 } from 'lucide-react';
import { IconButton, LoadingSkeleton } from '../components/ui';
import { Popup } from '../components/Motion';
import type { Session } from '../lib';
import type { DesktopUpdateState } from '../desktop-update';
import { compareVersions } from '../update-scripts';
import { DesktopHeaderActions } from '../components/DesktopTitleBar';

export type HeaderProps = {
  sidebarOpen: boolean;
  onOpenSidebar: () => void;
  isHome: boolean;
  chatMode?: boolean;
  panelAvailable?: boolean;
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
  onDelete: () => void;
  onCopyTitle: () => void;
  onShowChanges: () => void;
  onVersion: () => void;
  latestVersion?: string;
  desktopUpdate?: DesktopUpdateState;
};

function statusLabel(backend: HeaderProps['backend']) {
  if (backend.status === 'connecting') return '连接中';
  if (backend.status === 'error') return '连接失败';
  return backend.ready ? 'Loopra 已连接' : '需要配置模型';
}

export default function Header(p: HeaderProps) {
  const { session, menu, backend } = p;
  const version = backend.version.replace(/^v/i, '');
  const latestVersion = p.latestVersion?.replace(/^v/i, '');
  const versionLabel = version ? `v${version}` : 'v—';
  const desktop = p.desktopUpdate;
  const desktopVersion = desktop ? `v${desktop.currentVersion}` : versionLabel;
  const installedVersion = desktop ? desktop.currentVersion.replace(/^v/i, '') : version;
  const releaseVersion = desktop?.latestVersion?.replace(/^v/i, '') || latestVersion;
  // Manual-update builds also need a badge, even when the core is already current.
  const hasNewVersion = !!releaseVersion && /^\d+(?:\.\d+)*$/.test(installedVersion)
    && /^\d+(?:\.\d+)*$/.test(releaseVersion) && compareVersions(releaseVersion, installedVersion) > 0;
  const desktopText = desktop?.status === 'downloading' ? `下载中 ${Math.floor(desktop.percent)}%`
    : desktop?.status === 'verifying' ? '正在验证更新…'
    : desktop?.status === 'downloaded' ? '重启并安装'
    : desktop?.status === 'installing' ? '正在安装…'
    : desktop?.status === 'checking' ? '检查更新…'
    : desktop?.status === 'error' ? '更新失败，重试'
    : desktop?.status === 'available' || hasNewVersion ? '发现新版' : '';
  const updateText = desktop ? desktopText : hasNewVersion ? '发现新版' : '';
  const updateTitle = desktop ? `桌面端 ${desktopVersion}${hasNewVersion ? ` · 最新 v${releaseVersion}` : ''}${desktopText ? ` · ${desktopText}` : ''}`
    : hasNewVersion ? `当前版本 ${versionLabel}，发现新版本 v${latestVersion}` : `当前版本 ${versionLabel}`;
  return <header className={`conversation-header ${p.isHome ? 'home-header' : ''}`}>
    <div className="header-leading">
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
          <button role="menuitem" onClick={p.onDelete}><Trash2 size="1rem" />删除会话</button>
          <button role="menuitem" onClick={p.onCopyTitle}><Copy size="1rem" />复制会话标题</button>
        </Popup>
      </div>
    </div>}
    {/* Keep the flexible space inside the title's drag region, away from the right-hand controls. */}
    <div className="header-drag" aria-hidden="true" />
    </div>
    <DesktopHeaderActions>
      {!version && !desktop?.currentVersion && backend.status === 'connecting' ? <div className="header-version-loading" role="status" aria-label="正在加载版本"><LoadingSkeleton className="skeleton-version" /></div> : <button type="button" className={`app-version${updateText ? ' has-update' : ''}`}
        title={updateTitle}
        aria-label={updateTitle}
        onClick={p.onVersion}>
        {updateText
          ? <span className="app-version-update"><Download size="0.75rem" strokeWidth={1.8} aria-hidden="true" /><span>{updateText}</span></span>
          : <span className="app-version-number">{desktopVersion}</span>}
      </button>}
      <button className={`backend-status ${backend.status} ${backend.status === 'connected' && backend.ready ? 'is-ok' : ''}`} title={backend.error || `${statusLabel(backend)} · ${p.server} · ${versionLabel}`} onClick={p.onStatus}><span />{statusLabel(backend)}</button>
      {!p.isHome && !p.chatMode && <>
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
        <div data-popover className="menu-anchor">
          <button className="branch-button" onClick={() => p.onToggleMenu('branch')}><GitBranch />{p.gitBranch}</button>
          <Popup open={menu === 'branch'} className="popup branch-menu"><h3>当前分支</h3><button onClick={p.onShowChanges}><GitBranch size="0.9375rem" />{p.gitBranch}<Check size="1rem" /></button></Popup>
        </div>
      </>}
      {p.panelAvailable !== false && <IconButton label={p.chatMode ? p.changesOpen ? '关闭能力面板' : '打开能力面板' : p.changesOpen ? '关闭改动面板' : '打开改动面板'} active={p.changesOpen} onClick={p.onToggleChanges}><PanelRight size="1.0625rem" /></IconButton>}
    </DesktopHeaderActions>
  </header>;
}
