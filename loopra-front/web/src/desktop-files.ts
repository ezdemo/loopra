// 旧 FileExplorer.vue 的「重命名 / 在文件管理器中显示」走 Electron IPC
// （window.electronAPI.fileExplorer.rename / openFolder），后端没有对应 HTTP 接口。
// 浏览器版本按能力探测：只有暴露了 IPC 桥时才展示这两个入口。

export type RenameResult = { success?: boolean; error?: string; data?: { name: string; path: string } } | undefined;

export type DesktopFileBridge = {
  fileExplorer?: { rename?: (path: string, name: string) => Promise<RenameResult> };
  openFolder?: (path: string) => Promise<{ success?: boolean; error?: string } | undefined>;
};

export function desktopFileBridge(): DesktopFileBridge | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { electronAPI?: DesktopFileBridge }).electronAPI || null;
}

/** 是否可以通过桌面桥重命名 / 在系统文件管理器中定位文件。 */
export function canRenameFiles(bridge = desktopFileBridge()) {
  return typeof bridge?.fileExplorer?.rename === 'function';
}

export function canRevealFiles(bridge = desktopFileBridge()) {
  return typeof bridge?.openFolder === 'function';
}

/** 旧 FileExplorer.commitEdit 的校验：非空、非 . / ..、不含路径分隔符。 */
export function invalidFileName(name: string) {
  const value = String(name ?? '').trim();
  return !value || value === '.' || value === '..' || value.includes('/') || value.includes('\\');
}

export function baseName(path: string) {
  return String(path || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
}

/** 用新文件名推导同目录下的新路径（保持原分隔符风格为空，统一用 /）。 */
export function renamedPath(path: string, name: string) {
  const normalized = String(path || '').replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index < 0 ? name : `${normalized.slice(0, index + 1)}${name}`;
}
