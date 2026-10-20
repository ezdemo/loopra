// Desktop (Electron) window chrome for the React renderer.
//
// The React bundle is the default Electron main window (see
// `src/entry-routing.js`). On Windows and Linux the window is frameless
// (`frame: false`), so React draws its own drag region and
// minimize/maximize/close controls via the preload bridge
// (`window.electronAPI.window`); on macOS the window keeps the native traffic
// lights (`titleBarStyle: 'hiddenInset'`) and React draws only the drag region.

export type DesktopWindowApi = {
  minimize?: () => unknown;
  maximize?: () => unknown;
  close?: () => unknown;
  isMaximized?: () => Promise<boolean> | boolean;
};

export type DesktopProxyApi = {
  get?: () => Promise<{ success?: boolean; proxy?: string; error?: string }>;
  set?: (address: string) => Promise<{ success?: boolean; proxy?: string; error?: string }>;
};

type ElectronApi = {
  desktopUpdate?: import('./desktop-update').DesktopUpdateApi;
  isElectron?: boolean;
  platform?: string;
  window?: DesktopWindowApi;
  proxy?: DesktopProxyApi;
};

function currentWindow(): (Window & { electronAPI?: ElectronApi | null }) | null {
  return typeof window === 'undefined' ? null : (window as Window & { electronAPI?: ElectronApi | null });
}

export function electronApi(): ElectronApi | null {
  return currentWindow()?.electronAPI || null;
}

// Only treat the window as desktop-managed when the preload bridge actually
// exposes window controls; a bare `isElectron` flag is not enough.
export function desktopWindowApi(): DesktopWindowApi | null {
  const api = electronApi()?.window;
  return api && (api.minimize || api.maximize || api.close) ? api : null;
}

export function isDesktopWindow(): boolean {
  return !!desktopWindowApi();
}

export function desktopPlatform(): string {
  return electronApi()?.platform || 'win32';
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
  return platform === 'darwin';
}
