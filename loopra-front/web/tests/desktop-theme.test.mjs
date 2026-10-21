import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createDesktopTheme, registerDesktopThemeIpc } = require('../../electron/desktop-theme.cjs');

test('explicit app themes override the OS and stale menu color snapshots', () => {
  const nativeTheme = { themeSource: 'system' };
  const theme = createDesktopTheme(nativeTheme);
  theme.setSource('dark');
  assert.equal(nativeTheme.themeSource, 'dark');
  theme.applyMenuTheme('gray');
  assert.equal(nativeTheme.themeSource, 'dark');
  theme.setSource('light');
  theme.applyMenuTheme('dark');
  assert.equal(nativeTheme.themeSource, 'light');
});

test('switching back to system remains live after menus open in either color', () => {
  let systemDark = false;
  const nativeTheme = {
    themeSource: 'system',
    get shouldUseDarkColors() {
      return this.themeSource === 'system' ? systemDark : this.themeSource === 'dark';
    },
  };
  const theme = createDesktopTheme(nativeTheme);
  theme.setSource('dark');
  assert.equal(nativeTheme.shouldUseDarkColors, true);
  theme.setSource('system');
  theme.applyMenuTheme('gray');
  assert.equal(nativeTheme.shouldUseDarkColors, false);
  systemDark = true;
  theme.applyMenuTheme('dark');
  assert.equal(nativeTheme.themeSource, 'system');
  assert.equal(nativeTheme.shouldUseDarkColors, true);
});

test('legacy windows can supply their resolved menu theme before the main app syncs', () => {
  const nativeTheme = { themeSource: 'system' };
  const theme = createDesktopTheme(nativeTheme);
  theme.applyMenuTheme('dark');
  assert.equal(nativeTheme.themeSource, 'dark');
  theme.applyMenuTheme('gray');
  assert.equal(nativeTheme.themeSource, 'light');
});

test('identical syncs avoid native theme update loops and invalid values leave it unchanged', () => {
  let value = 'system';
  let updates = 0;
  const nativeTheme = {
    get themeSource() { return value; },
    set themeSource(next) { value = next; updates++; },
  };
  const theme = createDesktopTheme(nativeTheme);
  theme.setSource('dark');
  theme.setSource('dark');
  theme.applyMenuTheme('gray');
  assert.equal(updates, 1);
  assert.throws(() => theme.setSource('invalid'), /Invalid desktop theme/);
  assert.equal(nativeTheme.themeSource, 'dark');
});

test('only the live main renderer can set the desktop theme via IPC', () => {
  const handlers = new Map();
  const nativeTheme = { themeSource: 'system' };
  const theme = createDesktopTheme(nativeTheme);
  const window = { webContents: {}, isDestroyed: () => false };
  let mainWindow = window;
  registerDesktopThemeIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    getMainWindow: () => mainWindow, theme,
  });
  const set = handlers.get('desktop-theme-set');
  assert.throws(() => set({ sender: {} }, 'dark'), /Unauthorized/);
  assert.equal(nativeTheme.themeSource, 'system');
  assert.deepEqual(set({ sender: window.webContents }, 'dark'), { success: true });
  assert.equal(nativeTheme.themeSource, 'dark');
  assert.throws(() => set({ sender: window.webContents }, 'invalid'), /Invalid desktop theme/);
  window.isDestroyed = () => true;
  assert.throws(() => set({ sender: window.webContents }, 'light'), /Unauthorized/);
  mainWindow = null;
  assert.throws(() => set({ sender: window.webContents }, 'light'), /Unauthorized/);
});
