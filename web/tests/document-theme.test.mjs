import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/document-theme.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  .replace(/import\s+type\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];?/g, '')
  .replace(/import\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];?/g, '');
const { documentThemeIsDark, bootTheme, applyDocumentTheme } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'));

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
  assert.match(html, /#191919/);
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
  assert.equal(root.style.backgroundColor, '#191919');
  assert.equal(root.style.colorScheme, 'dark');
  assert.equal(meta.content, '#191919');
});
