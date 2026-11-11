declare global {
  interface Window {
    LoopraSystemBars?: { setDarkMode(dark: boolean): void };
  }
}

export type MobilePreferences = { fontSize: number; theme: 'system' | 'light' | 'dark' };
export const defaultPreferences: MobilePreferences = { fontSize: 16, theme: 'system' };
export function readPreferences(): MobilePreferences {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem('loopra:mobile:appearance') || 'null');
    if (!saved || typeof saved !== 'object') return defaultPreferences;
    const value = saved as Record<string, unknown>;
    return { fontSize: [15, 16, 18].includes(Number(value.fontSize)) ? Number(value.fontSize) : 16, theme: value.theme === 'light' || value.theme === 'dark' ? value.theme : 'system' };
  } catch { return defaultPreferences; }
}
export function savePreferences(preferences: MobilePreferences) { localStorage.setItem('loopra:mobile:appearance', JSON.stringify(preferences)); }
export function paintPreferences(preferences: MobilePreferences) {
  const dark = preferences.theme === 'dark' || preferences.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.add('workspace-theme');
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  document.documentElement.style.setProperty('--mobile-font-scale', String(preferences.fontSize / 16));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#09090a' : '#e9e9e6');
  window.LoopraSystemBars?.setDarkMode(dark);
}
