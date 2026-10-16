// Desktop (Electron) window chrome for the React renderer.
//
// The React bundle is the default Electron main window (see
// `src/entry-routing.js`). The window is frameless (`frame: false`), so React draws its own
// drag region and minimize/maximize/close controls via the preload bridge
// (`window.electronAPI.window`).

export type DesktopWindowApi = {
  minimize?: () => unknown;
  maximize?: () => unknown;
  close?: () => unknown;
  isMaximized?: () => Promise<boolean> | boolean;
};

type ElectronApi = {
  isElectron?: boolean;
  platform?: string;
  window?: DesktopWindowApi;
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

// macOS keeps its traffic lights on the left (`titleBarStyle: 'hiddenInset'`);
// Windows and Linux draw window controls on the right.
export function windowControlsOnLeft(platform: string): boolean {
  return platform === 'darwin';
}
