import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Pure diff parsing used by the workspace file preview (ported from the legacy
// DiffViewer.vue side-by-side pairing).
const source = await readFile(new URL('../src/diff.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { parseSideBySide, diffHunkCount, wordDiff, diffFolds, foldContext, mergeFileDiffs } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('pairs removed and added lines into replacements and keeps context', () => {
  const diff = [
    'diff --git a/a.txt b/a.txt',
    'index 111..222 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,3 +1,3 @@',
    ' keep',
    '-old',
    '+new',
  ].join('\n');
  assert.deepEqual(parseSideBySide(diff), [
    { type: 'context', left: 'keep', right: 'keep', leftLineNum: 1, rightLineNum: 1, hunkIndex: 0 },
    { type: 'replace', left: 'old', right: 'new', leftLineNum: 2, rightLineNum: 2, hunkIndex: 0 },
  ]);
});

test('numbers additions, removals and hunks independently', () => {
  const diff = [
    '@@ -10,1 +10,2 @@',
    '+a',
    '+b',
    '@@ -5,2 +5,0 @@',
    '-x',
    '-y',
  ].join('\n');
  const rows = parseSideBySide(diff);
  assert.deepEqual(rows, [
    { type: 'add', left: '', right: 'a', leftLineNum: null, rightLineNum: 10, hunkIndex: 0 },
    { type: 'add', left: '', right: 'b', leftLineNum: null, rightLineNum: 11, hunkIndex: 0 },
    { type: 'remove', left: 'x', right: '', leftLineNum: 5, rightLineNum: null, hunkIndex: 1 },
    { type: 'remove', left: 'y', right: '', leftLineNum: 6, rightLineNum: null, hunkIndex: 1 },
  ]);
  assert.equal(diffHunkCount(rows), 2);
});

test('represents an empty-file hunk and ignores metadata without hunks', () => {
  assert.deepEqual(parseSideBySide('@@ -0,0 +0,0 @@'), [
    { type: 'empty', left: '', right: '（空文件）', leftLineNum: null, rightLineNum: null, hunkIndex: 0 },
  ]);
  assert.deepEqual(parseSideBySide('diff --git a/a b/a\n--- a/a\n+++ b/a\n'), []);
  assert.deepEqual(parseSideBySide(undefined), []);
  assert.equal(diffHunkCount([]), 0);
});

// Legacy DiffViewer.vue pinned a 「旧版本 / 新版本」 header row above the
// side-by-side diff; the React preview originally dropped it. Mount the real
// component to prove the header renders above the paired rows.
const workbenchCss = await readFile(new URL('../src/workbench.css', import.meta.url), 'utf8');
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
const previousGlobals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => { dom.window.close(); for (const [key, descriptor] of previousGlobals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const diffModuleUrl = dataUrl(ts.transpileModule(await readFile(new URL('../src/diff.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
let viewText = ts.transpileModule(await readFile(new URL('../src/components/DiffView.tsx', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
for (const [specifier, url] of Object.entries({ react: import.meta.resolve('react'), 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), 'react-dom': import.meta.resolve('react-dom'), 'lucide-react': import.meta.resolve('lucide-react'), '../diff': diffModuleUrl })) {
  viewText = viewText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
}
const { default: DiffView } = await import(dataUrl(viewText));

test('the side-by-side view renders the legacy 旧版本/新版本 column header', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(DiffView, { diff: '@@ -1,1 +1,1 @@\n-old\n+new\n' })));
  const html = container.innerHTML;
  await act(async () => root.unmount());
  container.remove();
  assert.match(html, /<div class="diff-sbs-header"><span class="diff-sbs-label">旧版本<\/span><span class="diff-sbs-label">新版本<\/span><\/div>/);
  assert.ok(html.indexOf('diff-sbs-header') < html.indexOf('diff-sbs-row'));
  assert.match(workbenchCss, /\.diff-sbs-header \{/);
  assert.match(workbenchCss, /\.diff-sbs-label:first-child \{ border-right: 1px solid var\(--line\); \}/);
});

test('wordDiff marks only the tokens that changed inside a replaced line', () => {
  const { left, right } = wordDiff('const total = price * 2;', 'const total = price * qty;');
  assert.deepEqual(left.filter(part => part.changed).map(part => part.text), ['2']);
  assert.deepEqual(right.filter(part => part.changed).map(part => part.text), ['qty']);
  assert.equal(left.map(part => part.text).join(''), 'const total = price * 2;');
  assert.equal(right.map(part => part.text).join(''), 'const total = price * qty;');
  // Identical lines have nothing to highlight; unrelated lines are fully changed.
  assert.equal(wordDiff('same', 'same').left.some(part => part.changed), false);
  assert.equal(wordDiff('abc', 'xyz').right.every(part => part.changed), true);
});

test('diffFolds counts the unchanged lines hidden before each hunk', () => {
  const diff = ['@@ -10,2 +10,2 @@', ' a', '-b', '+c', '@@ -30,1 +30,1 @@', '-x', '+y'].join('\n');
  const rows = parseSideBySide(diff);
  const folds = diffFolds(rows);
  assert.equal(folds.get(0), 9);
  assert.equal(folds.get(rows.findIndex(row => row.hunkIndex === 1)), 18);
  assert.equal(diffFolds(parseSideBySide('@@ -1,1 +1,1 @@\n-a\n+b\n')).size, 0);
});

test('foldContext keeps three rows around each change and numbers every block as its own hunk', () => {
  const lines = Array.from({ length: 30 }, (_, index) => ` line${index + 1}`);
  lines[4] = '-old5\n+new5';
  lines[24] = '-old25\n+new25';
  const rows = foldContext(parseSideBySide(`@@ -1,30 +1,30 @@\n${lines.join('\n')}\n`));
  assert.equal(diffHunkCount(rows), 2);
  assert.deepEqual(rows.map(row => row.leftLineNum), [2, 3, 4, 5, 6, 7, 8, 22, 23, 24, 25, 26, 27, 28]);
  assert.equal(diffFolds(rows).get(0), 1);
  assert.equal(diffFolds(rows).get(7), 13);
  // Without any change there is nothing to fold.
  const same = parseSideBySide('@@ -1,2 +1,2 @@\n a\n b\n');
  assert.equal(foldContext(same), same);
});

test('mergeFileDiffs turns two whole-file diffs into the net change', () => {
  const merged = mergeFileDiffs('@@ -1,0 +1,2 @@\n+a\n+b\n', '@@ -1,2 +1,3 @@\n a\n b\n+c\n');
  assert.deepEqual(merged, { diff: '@@ -1,0 +1,3 @@\n+a\n+b\n+c\n', additions: 3, deletions: 0 });
  // Partial hunks cannot be reconstructed, so the caller falls back to concatenating.
  assert.equal(mergeFileDiffs('@@ -10,1 +10,1 @@\n-a\n+b\n', '@@ -1,1 +1,1 @@\n-a\n+b\n'), null);
  assert.equal(mergeFileDiffs(undefined, '@@ -1,1 +1,1 @@\n-a\n+b\n'), null);
});
