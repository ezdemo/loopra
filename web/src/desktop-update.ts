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

// This API always targets the desktop's own origin, even while the workbench
// is connected to a different Loopra server.
export function createNativeDesktopUpdateApi(request: typeof fetch = (...args) => fetch(...args)): DesktopUpdateApi {
  const listeners = new Set<(state: DesktopUpdateState) => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  let revision = -1;
  const accept = (state: DesktopUpdateState) => {
    if (state.revision > revision) {
      revision = state.revision;
      listeners.forEach(listener => listener(state));
    }
    return state;
  };
  async function call<T>(path: string, body?: unknown): Promise<T> {
    const response = await request(`/api/desktop-update/${path}`, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    const result = await response.json();
    if (!response.ok || result.success !== true) throw new Error(result.error || result.message || `HTTP ${response.status}`);
    return result.data as T;
  }
  async function poll() {
    if (polling || !listeners.size) return;
    polling = true;
    let delay = 1000;
    try {
      const state = accept(await call<DesktopUpdateState>('state'));
      if (['idle', 'downloaded', 'error', 'unsupported'].includes(state.status)) delay = 15000;
    }
    catch { /* A transient outage during restart is expected; commands report errors. */ }
    finally {
      polling = false;
      if (listeners.size) timer = setTimeout(() => void poll(), delay);
    }
  }
  return {
    getState: async () => accept(await call<DesktopUpdateState>('state')),
    getReleaseNotes: () => call<DesktopReleaseNotes>('notes'),
    check: async () => accept(await call<DesktopUpdateState>('check', {})),
    download: async () => accept(await call<DesktopUpdateState>('download', {})),
    install: async () => accept(await call<DesktopUpdateState>('install', {})),
    setSource: async source => accept(await call<DesktopUpdateState>('source', { source })),
    onState(callback) {
      listeners.add(callback);
      if (listeners.size === 1) void poll();
      return () => { listeners.delete(callback); if (!listeners.size && timer) { clearTimeout(timer); timer = undefined; } };
    },
  };
}

let nativeApi: DesktopUpdateApi | undefined;
export function desktopUpdateApi(): DesktopUpdateApi | undefined {
  if (typeof window === 'undefined') return undefined;
  const host = window as Window & { electronAPI?: { desktopUpdate?: DesktopUpdateApi }; mygo?: { window?: unknown } };
  if (host.electronAPI?.desktopUpdate) return host.electronAPI.desktopUpdate;
  if (!host.mygo?.window) return undefined;
  return nativeApi ??= createNativeDesktopUpdateApi();
}

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
