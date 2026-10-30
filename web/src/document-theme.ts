// Apply the saved appearance before the first paint. The desktop window
// otherwise draws the light page, then waits for React to add `.dark`.

export const themeSurface = { light: '#ffffff', dark: '#191919' } as const;

declare global {
  interface Window { __LOOPRA_THEME__?: string }
}

export function documentThemeIsDark(theme: string | undefined, systemDark: boolean): boolean {
  if (theme === '深色' || theme === '月之暗面' || theme === 'dark') return true;
  if (theme === '跟随系统' || theme === 'system') return systemDark;
  return false;
}

export function readStoredTheme(): string {
  try {
    const saved = JSON.parse(localStorage.getItem('loopra:preferences') || 'null') as { theme?: unknown } | null;
    return saved && typeof saved.theme === 'string' ? saved.theme : '';
  } catch {
    return '';
  }
}

export function stampedTheme(): string {
  const value = window.__LOOPRA_THEME__;
  if (value === 'dark') return '深色';
  if (value === 'light') return '浅色';
  if (value === 'system') return '跟随系统';
  return '';
}

/** Theme to paint before the server answers. A saved browser value wins; the page stamp covers a fresh window. */
export function bootTheme(): string {
  return readStoredTheme() || stampedTheme();
}

export function applyDocumentTheme(theme: string | undefined, systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches) {
  const dark = documentThemeIsDark(theme, systemDark);
  const root = document.documentElement;
  root.classList.add('workspace-theme');
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
  const color = dark ? themeSurface.dark : themeSurface.light;
  root.style.backgroundColor = color;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
}
