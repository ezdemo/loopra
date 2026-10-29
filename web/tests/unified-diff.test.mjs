import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { JSDOM } from 'jsdom';

// UnifiedDiff renders stored patches in chat file-change cards.
// Monaco cannot run under jsdom (it needs canvas
// measuring, ResizeObserver and Range.getClientRects), so the highlighting
// boundary is stubbed and the assertions cover the rows plus the plain-text
// fallback the stub forces.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { highlightStub } = await import('./helpers/highlight.mjs');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');

async function compile(path, aliases = {}) {
  let { outputText } = ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
  for (const [specifier, url] of Object.entries({ react: import.meta.resolve('react'), 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), 'lucide-react': import.meta.resolve('lucide-react'), ...aliases })) outputText = outputText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
  return dataUrl(outputText);
}

const diff = await compile('../src/diff.ts');
const workbenchCss = await readFile(new URL('../src/workbench.css', import.meta.url), 'utf8');
const paneCss = await readFile(new URL('../src/workspace-tabs.css', import.meta.url), 'utf8');
const chatCss = await readFile(new URL('../src/chat-blocks.css', import.meta.url), 'utf8');
const { default: UnifiedDiff } = await import(await compile('../src/components/UnifiedDiff.tsx', { '../diff': diff, '../highlight': highlightStub }));

// The colorized path the stub above turns off. The token runs are handed in as
// Monaco would return them and the real module does the splitting, so the tokens,
// the marks and the layout between them are the ones the browser renders.
const realHighlight = await compile('../src/highlight.ts');
const paintedStub = dataUrl(`
const real = await import(${JSON.stringify(realHighlight)});
export const MAX_HIGHLIGHT_CHARS = 200000;
export const highlightUri = (path, side) => side + '://highlight/' + path;
export const useHighlightRevision = () => 0;
// One run per line, with the tabs expanded the way Monaco expands them.
export const useColorizedLines = text => (text ? text.split('\\n').map(line => [{ cls: 'mtk1', text: line.replace(/\\t/g, '    ') }]) : null);
export const colorRunsText = real.colorRunsText;
export const splitRunsByMarks = real.splitRunsByMarks;
`);
const { default: PaintedDiff } = await import(await compile('../src/components/UnifiedDiff.tsx', { '../diff': diff, '../highlight': paintedStub }));

// jsdom has no element scrolling; the navigator calls it when it steps to a block.
const scrolled = [];
dom.window.HTMLElement.prototype.scrollTo = function (options) { scrolled.push(options); };

async function render(diffText, props = {}, Component = UnifiedDiff) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Component, { diff: diffText, ...props })));
  return {
    container,
    lines: () => [...container.querySelectorAll('.unified-diff-line')],
    text: () => [...container.querySelectorAll('.unified-diff-line')].map(line => line.textContent),
    async close() { await act(async () => root.unmount()); container.remove(); },
  };
}

test('a replaced line renders as the old line above the new one, numbered and signed', async () => {
  const view = await render('@@ -1,2 +1,2 @@\n keep\n-old\n+new\n');
  try {
    const lines = view.lines();
    assert.deepEqual(lines.map(line => line.className.replace('unified-diff-line ', '')), ['unified-diff-context', 'unified-diff-remove', 'unified-diff-add']);
    // The sign and the number are what an IDE diff shows in its gutter: the old
    // file's number for the removal, the new file's for the addition.
    assert.deepEqual(view.text(), ['1 keep', '2-old', '2+new']);
    // Only the changed rows are navigable, and both halves of the pair carry the
    // hunk so a jump lands on either.
    assert.deepEqual(lines.map(line => [line.getAttribute('data-change'), line.getAttribute('data-hunk-index')]), [['false', '0'], ['true', '0'], ['true', '0']]);
  } finally { await view.close(); }
});

test('the changed words of a pair are marked inside both halves', async () => {
  const view = await render('@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;\n');
  try {
    const marks = [...view.container.querySelectorAll('mark.diff-word')];
    assert.deepEqual(marks.map(mark => mark.textContent), ['1', '2']);
    // The removal sits in the row above the addition.
    assert.deepEqual(marks.map(mark => mark.closest('.unified-diff-line').className.includes('remove')), [true, false]);
  } finally { await view.close(); }
});

test('token runs paint each line and the word marks follow the painted text', async () => {
  // The colorizer expands the tab, so the marks only line up with the text it
  // actually returned: measuring them against the source line would misplace them.
  const view = await render('@@ -1,1 +1,1 @@\n-a\tb\n+a\tc\n', {}, PaintedDiff);
  try {
    assert.deepEqual(view.text(), ['1-a    b', '1+a    c']);
    const marks = [...view.container.querySelectorAll('mark.diff-word')];
    assert.deepEqual(marks.map(mark => mark.textContent), ['b', 'c']);
    // The token class survives the split, inside the mark as much as outside it.
    assert.equal(marks[0].querySelector('span.mtk1')?.textContent, 'b');
    assert.equal(marks[0].closest('.unified-diff-line').className.includes('remove'), true);
    assert.ok(view.container.querySelectorAll('.unified-diff-code > span.mtk1').length >= 2);
  } finally { await view.close(); }
});

test('runs of untouched lines collapse into a labelled marker', async () => {
  const view = await render('@@ -10,2 +10,2 @@\n a\n-b\n+c\n@@ -30,1 +30,1 @@\n-x\n+y\n');
  try {
    assert.deepEqual([...view.container.querySelectorAll('.unified-diff-fold')].map(fold => fold.textContent), ['⋯ 9 行未更改', '⋯ 18 行未更改']);
    // The marker comes before the change it hides.
    assert.equal(view.container.querySelector('.unified-diff').firstElementChild.className, 'unified-diff-fold');
  } finally { await view.close(); }
});

test('the change navigator is opt-in and counts the blocks it can jump between', async () => {
  // Two changes far enough apart that folding keeps them in separate blocks.
  const apart = '@@ -1,12 +1,12 @@\n-a\n+b\n c1\n c2\n c3\n c4\n c5\n c6\n c7\n c8\n-c\n+d\n';
  const plain = await render(apart);
  try { assert.equal(plain.container.querySelector('.diff-hunk-nav'), null); } finally { await plain.close(); }
  const view = await render(apart, { nav: true });
  try {
    assert.equal(view.container.querySelector('.diff-hunk-nav').getAttribute('aria-label'), '差异块导航');
    assert.equal(view.container.querySelector('.diff-hunk-position').textContent, '2 处差异');
    // Nothing is current until the reader scrolls or steps to a change.
    assert.deepEqual([...view.container.querySelectorAll('.diff-hunk-nav button')].map(button => button.disabled), [true, false]);
    // The block itself separates the two changes, so the middle context is folded.
    assert.deepEqual([...view.container.querySelectorAll('.unified-diff-fold')].map(fold => fold.textContent), ['⋯ 2 行未更改']);
    // Stepping marks each block as current and scrolls it into view.
    scrolled.length = 0;
    const click = async element => { await act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))); };
    const [back, forward] = view.container.querySelectorAll('.diff-hunk-nav button');
    const position = () => view.container.querySelector('.diff-hunk-position').textContent;
    await click(forward);
    assert.equal(position(), '2 处差异 · 当前 1');
    await click(forward);
    assert.equal(position(), '2 处差异 · 当前 2');
    assert.deepEqual([...view.container.querySelectorAll('.diff-hunk-nav button')].map(button => button.disabled), [false, true]);
    await click(back);
    assert.equal(position(), '2 处差异 · 当前 1');
    // Two steps forward scroll to a block, one step back follows.
    assert.deepEqual(scrolled, [{ top: 0, behavior: 'smooth' }, { top: 0, behavior: 'smooth' }, { top: 0, behavior: 'smooth' }]);
  } finally { await view.close(); }
});

test('an unreadable patch falls back to its raw text instead of an empty pane', async () => {
  const raw = await render('diff --git a/a b/a\n--- a/a\n+++ b/a\n');
  try {
    assert.equal(raw.container.querySelector('.unified-diff'), null);
    assert.equal(raw.container.querySelector('pre.workspace-preview-raw').textContent, 'diff --git a/a b/a\n--- a/a\n+++ b/a\n');
  } finally { await raw.close(); }
  // No patch at all renders nothing unless the caller supplies the wording.
  const blank = await render(undefined);
  try { assert.equal(blank.container.innerHTML, ''); } finally { await blank.close(); }
  const empty = await render(undefined, { emptyText: '该文件没有未提交的改动。' });
  try {
    assert.equal(empty.container.querySelector('p.panel-empty').textContent, '该文件没有未提交的改动。');
    assert.equal(empty.container.querySelector('.unified-diff'), null);
  } finally { await empty.close(); }
});

test('the stylesheet tints the whole row and keeps the gutter in view', () => {
  assert.match(workbenchCss, /\.unified-diff \{ --diff-add: /);
  assert.match(workbenchCss, /\.unified-diff-add \{ background: var\(--diff-add\); \}/);
  assert.match(workbenchCss, /\.unified-diff-remove \{ background: var\(--diff-del\); \}/);
  assert.match(workbenchCss, /\.unified-diff-gutter \{ position: sticky; left: 0;/);
  assert.match(workbenchCss, /\.unified-diff-fold \{/);
  // The changed words carry their own tint inside a changed row.
  assert.match(workbenchCss, /\.unified-diff-add \.diff-word \{ background: var\(--diff-word-add\); \}/);
  assert.match(workbenchCss, /\.unified-diff-remove \.diff-word \{ background: var\(--diff-word-del\); \}/);
  // A sticky gutter only hides the code scrolling under it if its own background
  // is opaque, so the tints its `inherit` picks up may not be translucent.
  const block = workbenchCss.match(/\.unified-diff \{[^}]*\}/)[0];
  assert.match(block, /background: var\(--surface\)/);
  assert.doesNotMatch(block, /transparent/);
  assert.match(workbenchCss, /\.unified-diff-line \{[^}]*background: var\(--surface\)/);
  // The two-column layout is gone: no rule may keep sizing the old grid.
  assert.doesNotMatch(workbenchCss, /\.diff-sbs/);
});

test('chat cards size stored patches while workspace files host the code editor', () => {
  assert.match(paneCss, /\.workspace-code-editor \{ flex: 1 1 0;/);
  assert.doesNotMatch(paneCss, /\.workspace-file-body \.unified-diff/);
  assert.doesNotMatch(paneCss, /\.diff-sbs/);
  assert.match(chatCss, /\.file-change-diff \.unified-diff \{ max-height: 22rem;/);
});
