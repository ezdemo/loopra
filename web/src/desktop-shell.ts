// Desktop (Electron) window chrome for the React renderer.
//
// The React bundle is the default Electron main window (see
// `src/entry-routing.js`). On Windows and Linux the window is frameless
// (`frame: false`), so React draws its own drag region and
// minimize/maximize/close controls via the preload bridge
// (`window.electronAPI.window`); on macOS the window keeps the native traffic
// lights (`titleBarStyle: 'hiddenInset'`) and React draws only the drag region.

export type DesktopWindowApi = {
  ready?: () => Promise<unknown> | unknown;
  minimize?: () => unknown;
  maximize?: () => unknown;
  close?: () => unknown;
  isMaximized?: () => Promise<boolean> | boolean;
};

export type DesktopProxyApi = {
  get?: () => Promise<{ success?: boolean; proxy?: string; error?: string }>;
  set?: (address: string) => Promise<{ success?: boolean; proxy?: string; error?: string }>;
};

export type DesktopThemeSource = 'dark' | 'light' | 'system';

type ElectronApi = {
  localProfile?: {
    get: () => Promise<import('./local-profile').LocalProfile | null>;
    set: (profile: import('./local-profile').LocalProfile) => Promise<unknown>;
  };
  desktopTheme?: { set?: (source: DesktopThemeSource) => Promise<unknown> | unknown };
  desktopUpdate?: import('./desktop-update').DesktopUpdateApi;
  isElectron?: boolean;
  platform?: string;
  window?: DesktopWindowApi;
  proxy?: DesktopProxyApi;
};

type MyGoWindowControls = {
  minimize?: () => unknown;
  maximize?: () => unknown;
  toggleMaximize?: () => unknown;
  close?: () => unknown;
  isMaximized?: () => Promise<boolean> | boolean;
};

type MyGoHost = {
  platform?: string;
  window?: MyGoWindowControls;
  runtime?: { platform?: string };
};

function currentWindow(): (Window & { electronAPI?: ElectronApi | null; mygo?: MyGoHost | null }) | null {
  return typeof window === 'undefined' ? null : (window as Window & { electronAPI?: ElectronApi | null; mygo?: MyGoHost | null });
}

function myGoHost(): MyGoHost | null {
  return currentWindow()?.mygo || null;
}

// mygo injects window controls on a frameless WebView. Map them onto the same
// shape DesktopTitleBar already uses for the Electron preload bridge.
function myGoWindowApi(): DesktopWindowApi | null {
  const controls = myGoHost()?.window;
  if (!controls || !(controls.minimize || controls.toggleMaximize || controls.maximize || controls.close)) return null;
  return {
    minimize: () => controls.minimize?.(),
    maximize: () => (controls.toggleMaximize ?? controls.maximize)?.(),
    close: () => controls.close?.(),
    isMaximized: () => Promise.resolve(controls.isMaximized?.() ?? false),
  };
}

export function electronApi(): ElectronApi | null {
  return currentWindow()?.electronAPI || null;
}

export function desktopThemeSource(preference: string): DesktopThemeSource {
  return preference === '深色' ? 'dark' : preference === '浅色' ? 'light' : 'system';
}

export async function syncDesktopTheme(preference: string): Promise<void> {
  await electronApi()?.desktopTheme?.set?.(desktopThemeSource(preference));
}

// Only treat the window as desktop-managed when the preload bridge actually
// exposes window controls; a bare `isElectron` flag is not enough.
export function desktopWindowApi(): DesktopWindowApi | null {
  const api = electronApi()?.window;
  if (api && (api.minimize || api.maximize || api.close)) return api;
  return myGoWindowApi();
}

export function notifyDesktopWorkspaceAfterPaint(): () => void {
  const page = currentWindow();
  const ready = desktopWindowApi()?.ready;
  if (!page || !ready) return () => {};
  // A frame callback runs before paint; the next frame confirms a paint opportunity.
  let frame = page.requestAnimationFrame(() => {
    frame = page.requestAnimationFrame(() => { void ready(); });
  });
  return () => page.cancelAnimationFrame(frame);
}

export function isDesktopWindow(): boolean {
  return !!desktopWindowApi();
}

export function desktopPlatform(): string {
  const host = myGoHost();
  return electronApi()?.platform || host?.platform || host?.runtime?.platform || 'win32';
}

// 只有 preload 暴露了 proxy.set 才能把设置同步到 Electron 的 defaultSession；
// 浏览器页面没有这个桥接，代理只作用于 Java 后端。
export function electronProxyApi(): DesktopProxyApi | null {
  return electronApi()?.proxy || null;
}

// macOS paints its own traffic lights over the hidden title bar
// (`titleBarStyle: 'hiddenInset'` in the main process), so drawing controls here
// would duplicate them. Windows and Linux have no native controls to fall back
// on, so the renderer must draw them.
export function usesNativeWindowControls(platform: string): boolean {
  // A mygo window is frameless on every platform, so the page draws the buttons.
  if (myGoHost()?.window) return false;
  return platform === 'darwin';
}
