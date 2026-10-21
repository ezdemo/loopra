import type { ReleaseNotes } from './release-notes';

export type DesktopUpdateState = {
  supported: boolean;
  unsupportedReason?: string;
  packageType?: string;
  installHint?: string;
  currentVersion: string;
  status: 'unsupported' | 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'downloaded' | 'installing' | 'error';
  latestVersion: string;
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
  error: string;
  checkedAt: string;
  revision: number;
  source: string;
  changingSource: boolean;
};

export type DesktopReleaseNotes = ReleaseNotes;

export type DesktopUpdateApi = {
  getState: () => Promise<DesktopUpdateState>;
  getReleaseNotes: () => Promise<DesktopReleaseNotes>;
  setSource: (source: string) => Promise<DesktopUpdateState>;
  check: () => Promise<DesktopUpdateState>;
  download: () => Promise<DesktopUpdateState>;
  install: () => Promise<DesktopUpdateState>;
  onState: (callback: (state: DesktopUpdateState) => void) => () => void;
};

export function desktopUpdateLabel(state: DesktopUpdateState): string {
  switch (state.status) {
    case 'checking': return '正在检查桌面端更新…';
    case 'available': return '发现新版，即将自动下载';
    case 'downloading': return `正在下载 ${Math.floor(state.percent)}%`;
    case 'verifying': return '下载完成，正在验证更新…';
    case 'downloaded': return '下载完成，重启后安装';
    case 'installing': return '正在重启安装…';
    case 'error': return '更新失败，可重试';
    case 'unsupported': return state.unsupportedReason || '此版本请从发布页下载安装';
    default: return state.checkedAt ? '当前桌面端已是最新版本' : '将自动检查桌面端更新';
  }
}
