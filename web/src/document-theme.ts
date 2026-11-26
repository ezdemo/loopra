import { normalizeAccentColor, resolveAccentColor } from './accent-color';

// Apply the saved appearance before the first paint. The desktop window
// otherwise draws the light page, then waits for React to add `.dark`.

export const themeSurface = { light: '#ffffff', dark: '#0a0a0a' } as const;

declare global {
  interface Window { __LOOPRA_THEME__?: string }
}

export function documentThemeIsDark(theme: string | undefined, systemDark: boolean): boolean {
  if (theme === '深色' || theme === '月之暗面' || theme === 'dark') return true;
  if (theme === '跟随系统' || theme === 'system') return systemDark;
  return false;
}

function readStoredAppearance(): { theme?: unknown; accentColor?: unknown } | null {
  try {
    return JSON.parse(localStorage.getItem('loopra:preferences') || 'null');
  } catch {
    return null;
  }
}

export function readStoredTheme(): string {
  const theme = readStoredAppearance()?.theme;
  return typeof theme === 'string' ? theme : '';
}

export function readStoredAccentColor(): string {
  return normalizeAccentColor(readStoredAppearance()?.accentColor);
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

export function applyDocumentAccent(value: unknown, dark: boolean) {
  const accent = resolveAccentColor(value, dark);
  const tokens = {
    '--blue': accent?.hex,
    '--accent-soft': accent && `${accent.hex}26`,
    '--accent-foreground': accent?.foreground,
    '--keyboard-focus': accent?.hex,
    '--nextui-primary': accent?.hsl,
    '--nextui-primary-foreground': accent?.foregroundHsl,
    '--nextui-focus': accent?.hsl,
  };
  const { style } = document.documentElement;
  for (const [name, color] of Object.entries(tokens)) {
    if (color) style.setProperty(name, color);
    else style.removeProperty(name);
  }
}
