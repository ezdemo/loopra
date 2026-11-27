import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/document-theme.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  .replace(/import\s+type\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];?/g, '')
  .replace(/import\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];?/g, '');
const accentSource = await readFile(new URL('../src/accent-color.ts', import.meta.url), 'utf8');
const accentJs = ts.transpileModule(accentSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  .replace(/^export /gm, '');
const { documentThemeIsDark, bootTheme, applyDocumentTheme, readStoredAccentColor, applyDocumentAccent } = await import('data:text/javascript;base64,' + Buffer.from(`${accentJs}
${js}`).toString('base64'));

test('an explicit dark theme is dark before the page asks the system', () => {
  assert.equal(documentThemeIsDark('深色', false), true);
  assert.equal(documentThemeIsDark('月之暗面', false), true);
  assert.equal(documentThemeIsDark('浅色', true), false);
  assert.equal(documentThemeIsDark('', true), false);
  assert.equal(documentThemeIsDark('跟随系统', true), true);
  assert.equal(documentThemeIsDark('跟随系统', false), false);
});

test('the boot theme prefers this window cache, then the page stamp', () => {
  const store = new Map();
  globalThis.localStorage = { getItem: key => store.get(key) ?? null };
  globalThis.window = {};
  assert.equal(bootTheme(), '');
  window.__LOOPRA_THEME__ = 'dark';
  assert.equal(bootTheme(), '深色');
  store.set('loopra:preferences', JSON.stringify({ theme: '浅色' }));
  assert.equal(bootTheme(), '浅色');
});

test('the document theme is applied before React paints', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const main = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
  assert.match(html, /window\.__LOOPRA_THEME__=""/);
  assert.match(html, /loopra:preferences/);
  assert.match(html, /#0a0a0a/);
  assert.match(main, /applyDocumentTheme\(bootTheme\(\)\)/);
  assert.match(app, /useLayoutEffect\(\(\) => \{\s*applyDocumentTheme\(preferences\.theme, systemDark\)/);
});

test('applyDocumentTheme paints the saved dark surface on the document', () => {
  const root = {
    classList: { add() {}, toggle(name, on) { this.dark = name === 'dark' && on; } },
    style: {},
  };
  const meta = { setAttribute(name, value) { this[name] = value; } };
  globalThis.document = { documentElement: root, querySelector: () => meta };
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  applyDocumentTheme('深色', false);
  assert.equal(root.classList.dark, true);
  assert.equal(root.style.backgroundColor, '#0a0a0a');
  assert.equal(root.style.colorScheme, 'dark');
  assert.equal(meta.content, '#0a0a0a');
});

function fakeStyle() {
  const map = new Map();
  return {
    map,
    setProperty(name, value) { map.set(name, value); },
    removeProperty(name) { map.delete(name); },
  };
}

test('readStoredAccentColor normalizes the cached color and rejects junk', () => {
  const store = new Map();
  globalThis.localStorage = { getItem: key => store.get(key) ?? null };
  assert.equal(readStoredAccentColor(), '');
  store.set('loopra:preferences', JSON.stringify({ accentColor: ' #2A90FF ' }));
  assert.equal(readStoredAccentColor(), '#2a90ff');
  store.set('loopra:preferences', JSON.stringify({ accentColor: 'red' }));
  assert.equal(readStoredAccentColor(), '');
  store.set('loopra:preferences', '{broken');
  assert.equal(readStoredAccentColor(), '');
});

test('applyDocumentAccent sets readable tokens and clears them on reset', () => {
  const style = fakeStyle();
  globalThis.document = { documentElement: { style } };
  // Black passes the light-theme contrast floor unchanged; white passes in dark.
  applyDocumentAccent('#000000', false);
  assert.equal(style.map.get('--blue'), '#000000');
  assert.equal(style.map.get('--accent-foreground'), '#fff');
  assert.ok(style.map.get('--nextui-primary'));
  assert.equal(style.map.get('--accent-soft'), '#00000026');

  applyDocumentAccent('#ffffff', true);
  assert.equal(style.map.get('--blue'), '#ffffff');
  assert.equal(style.map.get('--accent-foreground'), '#000');
  assert.equal(style.map.get('--nextui-primary-foreground'), '0 0% 0%');

  // Mid-tone presets shift just enough to stay readable in both themes.
  applyDocumentAccent('#2563eb', false);
  assert.notEqual(style.map.get('--blue'), '#2563eb');
  assert.match(style.map.get('--blue'), /^#[0-9a-f]{6}$/);
  applyDocumentAccent('#2563eb', true);
  assert.notEqual(style.map.get('--blue'), '#2563eb');
  assert.match(style.map.get('--blue'), /^#[0-9a-f]{6}$/);

  // A saturated low-contrast color is shifted for readability, but the raw
  // cached choice is untouched.
  const store = new Map([['loopra:preferences', JSON.stringify({ accentColor: '#facc15' })]]);
  globalThis.localStorage = { getItem: key => store.get(key) ?? null };
  applyDocumentAccent('#facc15', false);
  assert.notEqual(style.map.get('--blue'), '#facc15');
  assert.ok(style.map.get('--blue').startsWith('#'));
  assert.equal(readStoredAccentColor(), '#facc15');

  const keys = [...style.map.keys()];
  assert.ok(keys.length > 0);
  applyDocumentAccent('', false);
  for (const key of keys) assert.equal(style.map.has(key), false, key);
  applyDocumentAccent('red', true);
  assert.equal(style.map.size, 0);
});

function hexLuminance(hex) {
  const channels = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255).map(value => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrastRatio(a, b) {
  const first = hexLuminance(a), second = hexLuminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test('dark text selection is clearly visible and readable', async () => {
  const css = await readFile(new URL('../src/workspace-theme.css', import.meta.url), 'utf8');
  const dark = css.match(/\.workspace-theme\.dark[\s\S]*?\n}/)?.[0] || '';
  const token = name => dark.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1];
  const surface = token('surface'), background = token('selection-background'), foreground = token('selection-foreground');
  assert.ok(surface && background && foreground, 'dark selection tokens are explicit colors');
  assert.ok(contrastRatio(background, foreground) >= 7, 'selected text stays readable');
  assert.ok(contrastRatio(background, surface) >= 3, 'the selection is visible on the dark surface');
});

test('the boot script applies the cached accent before React mounts', async () => {
  const main = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
  const themeAt = main.indexOf('applyDocumentTheme(bootTheme())');
  const accentAt = main.indexOf('applyDocumentAccent(readStoredAccentColor()');
  const renderAt = main.indexOf('root.render(');
  assert.ok(themeAt !== -1 && accentAt !== -1 && renderAt !== -1);
  assert.ok(themeAt < accentAt && accentAt < renderAt);
});
