import { useTranslation } from 'react-i18next';
import { ArrowLeft, Check, ChevronDown, Copy, Download, FileCode2, FolderClosed, GitBranch, MessageCirclePlus, MoreHorizontal, PanelLeft, PanelRight, ScrollText, SquareTerminal, Trash2 } from 'lucide-react';
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
  workspaceActions?: boolean;
  returnToChat?: { label: string; onClick: () => void };
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
  shellOpen: boolean;
  onToggleShell: () => void;
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

function statusLabel(backend: HeaderProps['backend'], t: (key: string) => string) {
  if (backend.status === 'connecting') return t('header.status.connecting');
  if (backend.status === 'error') return t('header.status.error');
  return backend.ready ? t('header.status.connected') : t('header.status.needsModel');
}

export default function Header(p: HeaderProps) {
  const { t } = useTranslation();
  const { session, menu, backend } = p;
  const gitBranchLabel = p.gitBranch === '未初始化' ? t('header.gitUninitialized') : p.gitBranch === '工作区' ? t('header.workspaceFallback') : p.gitBranch;
  const version = backend.version.replace(/^v/i, '');
  const latestVersion = p.latestVersion?.replace(/^v/i, '');
  const versionLabel = version ? `v${version}` : 'v—';
  const desktop = p.desktopUpdate;
  const desktopVersion = desktop ? `v${desktop.currentVersion}` : versionLabel;
  const installedVersion = desktop ? desktop.currentVersion.replace(/^v/i, '') : version;
  const releaseVersion = desktop?.latestVersion?.replace(/^v/i, '') || latestVersion;
  // Manual-update builds also need a badge, even when the core is already current.
  const hasNewVersion = !desktop?.development && !!releaseVersion && /^\d+(?:\.\d+)*$/.test(installedVersion)
    && /^\d+(?:\.\d+)*$/.test(releaseVersion) && compareVersions(releaseVersion, installedVersion) > 0;
  const desktopText = desktop?.development ? '' : desktop?.status === 'downloading' ? t('header.downloading', { percent: Math.floor(desktop.percent) })
    : desktop?.status === 'verifying' ? t('header.verifying')
    : desktop?.status === 'downloaded' ? t('header.restartInstall')
    : desktop?.status === 'installing' ? t('header.installing')
    : desktop?.status === 'checking' ? t('header.checking')
    : desktop?.status === 'error' ? t('header.updateFailed')
    : desktop?.status === 'available' || hasNewVersion ? t('header.updateAvailable') : '';
  const updateText = desktop ? desktopText : hasNewVersion ? t('header.updateAvailable') : '';
  const updateTitle = desktop ? `${t('header.desktopVersion', { version: desktopVersion })}${desktop.development ? ` · ${t('header.developmentBuild')}` : ''}${hasNewVersion ? ` · ${t('header.latestVersion', { version: releaseVersion })}` : ''}${desktopText ? ` · ${desktopText}` : ''}`
    : hasNewVersion ? t('header.currentVersionWithUpdate', { version: versionLabel, latest: latestVersion }) : t('header.currentVersion', { version: versionLabel });
  return <header className={`conversation-header ${p.isHome ? 'home-header' : ''}`}>
    <div className="header-leading">
    {p.returnToChat ? <>
      <IconButton label={p.returnToChat.label} onClick={p.returnToChat.onClick}><ArrowLeft size="1rem" /></IconButton>
      <span className="surface-header-brand">Loopra</span>
    </> : !p.sidebarOpen && <IconButton label={t('nav.expandSidebar')} className="sidebar-reopen" onClick={p.onOpenSidebar}><PanelLeft size="1.0625rem" /></IconButton>}
    {!p.isHome && session && <div className="breadcrumb">
      <span>{p.workspaceName}</span><span className="breadcrumb-divider">/</span><strong title={session.title}>{session.title}</strong>
      <div data-popover="session" className="menu-anchor">
        <IconButton label={t('header.sessionOptions')} onClick={() => p.onToggleMenu('session')}><MoreHorizontal size="1rem" /></IconButton>
        <Popup open={menu === 'session'} className="popup session-menu" role="menu">
          <button role="menuitem" onClick={p.onRename}><FileCode2 size="1rem" />{t('header.renameSession')}</button>
          <button role="menuitem" onClick={p.onRecords}><ScrollText size="1rem" />{t('header.sessionRecords')}</button>
          <button role="menuitem" onClick={p.onClear}><MessageCirclePlus size="1rem" />{t('header.clearConversation')}</button>
          <button role="menuitem" onClick={p.onExport}><Download size="1rem" />{t('header.exportConversation')}</button>
          <button role="menuitem" onClick={p.onDelete}><Trash2 size="1rem" />{t('header.deleteConversation')}</button>
          <button role="menuitem" onClick={p.onCopyTitle}><Copy size="1rem" />{t('header.copySessionTitle')}</button>
        </Popup>
      </div>
    </div>}
    {/* Keep the flexible space inside the title's drag region, away from the right-hand controls. */}
    <div className="header-drag" aria-hidden="true" />
    </div>
    <DesktopHeaderActions>
      {!version && !desktop?.currentVersion && backend.status === 'connecting' ? <div className="header-version-loading" role="status" aria-label={t('header.loadingVersion')}><LoadingSkeleton className="skeleton-version" /></div> : <button type="button" className={`app-version${updateText ? ' has-update' : ''}`}
        title={updateTitle}
        aria-label={updateTitle}
        onClick={p.onVersion}>
        {updateText
          ? <span className="app-version-update"><Download size="0.75rem" strokeWidth={1.8} aria-hidden="true" /><span>{updateText}</span></span>
          : <span className="app-version-number">{desktopVersion}</span>}
      </button>}
      <button className={`backend-status ${backend.status} ${backend.status === 'connected' && backend.ready ? 'is-ok' : ''}`} title={backend.error || `${statusLabel(backend, t)} · ${p.server} · ${versionLabel}`} onClick={p.onStatus}><span />{statusLabel(backend, t)}</button>
      {(p.workspaceActions ?? !p.isHome) && !p.chatMode && <>
        <div data-popover="folder" className="menu-anchor">
          <div className="folder-split">
            <button aria-label={t('header.openInSystemApp')} onClick={() => p.onOpenWorkspace()}><FolderClosed /></button>
            <button aria-label={t('header.openWith')} onClick={() => p.onToggleMenu('folder')}><ChevronDown /></button>
          </div>
          <Popup open={menu === 'folder'} className="popup folder-menu" role="menu">
            {p.applications.map(item => <button key={item.application} role="menuitem" onClick={() => p.onOpenWorkspace(item.name)}>{item.application === 'folder' ? <FolderClosed size="1rem" /> : <SquareTerminal size="1rem" />}{item.label}</button>)}
            <hr />
            <button role="menuitem" onClick={p.onCopyPath}><Copy size="1rem" />{t('header.copyPath')}</button>
          </Popup>
        </div>
        <div data-popover="branch" className="menu-anchor">
          <button className="branch-button" onClick={() => p.onToggleMenu('branch')}><GitBranch />{gitBranchLabel}</button>
          <Popup open={menu === 'branch'} className="popup branch-menu"><h3>{t('header.currentBranch')}</h3><button onClick={p.onShowChanges}><GitBranch size="0.9375rem" />{gitBranchLabel}<Check size="1rem" /></button></Popup>
        </div>
      </>}
      {p.panelAvailable !== false && <IconButton label={p.shellOpen ? t('header.hideTerminal') : t('header.openTerminal')} active={p.shellOpen} onClick={p.onToggleShell}><SquareTerminal size="1.0625rem" /></IconButton>}
      {p.panelAvailable !== false && <IconButton label={p.chatMode ? p.changesOpen ? t('header.closeCapabilityPanel') : t('header.openCapabilityPanel') : p.changesOpen ? t('header.closeChangesPanel') : t('header.openChangesPanel')} active={p.changesOpen} onClick={p.onToggleChanges}><PanelRight size="1.0625rem" /></IconButton>}
    </DesktopHeaderActions>
  </header>;
}
