import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/ui-preferences.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  .replace(/import\s+type\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];?/g, '')
  .replace(/import\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];?/g, '');
const uiScale = await readFile(new URL('../src/lib.ts', import.meta.url), 'utf8');
const scaleStart = uiScale.indexOf('export const UI_SCALE_LEVELS');
const scaleEnd = uiScale.indexOf('export function useLocalState');
const scaleJs = ts.transpileModule(uiScale.slice(scaleStart, scaleEnd), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  .replace(/^export /gm, '');
const { toStoredPreferences, fromStoredPreferences, toStoredSettings, mergeStoredSettings } = await import('data:text/javascript;base64,' + Buffer.from(`${scaleJs}\n${js}`).toString('base64'));

const local = { theme: '深色', language: 'English', fontScale: 110, notifications: false, sound: true, openWith: 'Terminal', autoContext: false, animations: true };

test('general preferences use the service theme and language codes', () => {
  assert.deepEqual(toStoredPreferences(local), {
    theme: 'dark', language: 'en', fontScale: 110, notifications: false, sound: true, openWith: 'Terminal', autoContext: false, animations: true,
  });
  assert.equal(toStoredPreferences({ ...local, theme: '跟随系统' }).theme, 'system');
  assert.equal(toStoredPreferences({ ...local, theme: '浅色', language: '简体中文' }).language, 'zh');
});

test('a saved service record restores the settings labels', () => {
  const fallback = { ...local, theme: '浅色', language: '简体中文' };
  assert.deepEqual(fromStoredPreferences({ theme: 'system', language: 'en', fontScale: 80, notifications: false, sound: false, openWith: 'Terminal', autoContext: false, animations: false }, fallback), {
    theme: '跟随系统', language: 'English', fontScale: 80, notifications: false, sound: false, openWith: 'Terminal', autoContext: false, animations: false,
  });
});

test('profile, pet visibility and hidden sessions travel with the same record', () => {
  const settings = {
    preferences: local,
    profile: { nickname: '小环', avatar: '', color: 'rose' },
    petEnabled: true,
    hiddenSessions: ['d0ab4c2fbf56/loopra-1'],
  };
  const stored = toStoredSettings(settings);
  assert.equal(stored.theme, 'dark');
  assert.equal(stored.petEnabled, true);
  assert.deepEqual(stored.hiddenSessions, ['d0ab4c2fbf56/loopra-1']);
  assert.equal(stored.profile.nickname, '小环');
  const partial = mergeStoredSettings({ theme: 'light', language: 'zh', fontScale: 100 }, settings);
  assert.equal(partial.complete, false);
  assert.equal(partial.settings.profile.nickname, '小环');
  assert.equal(partial.settings.petEnabled, true);
  const full = mergeStoredSettings({ ...stored, profile: { nickname: ' 环 ', avatar: 'javascript:alert(1)', color: 'nope' } }, settings);
  assert.equal(full.complete, true);
  assert.equal(full.settings.profile.nickname, '环');
  assert.equal(full.settings.profile.avatar, '');
  assert.equal(full.settings.profile.color, 'blue');
});

test('the workbench loads and writes settings on the service', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /api\.request<StoredUIPreferences>\('\/ui-preferences'/);
  assert.match(app, /api\.request\('\/ui-preferences', 'PUT', toStoredSettings/);
  assert.match(app, /onPreferences=\{savePreferences\}/);
  assert.match(app, /onSave=\{saveProfile\}/);
});
