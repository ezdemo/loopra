import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { JSDOM } from 'jsdom';

// The chat file-change card expands the patch the turn saved as a single-column
// diff inside the message, and keeps the workspace pane one click away. The
// message list itself is covered elsewhere; here the real BlockRenderer is
// mounted with only its heavy leaves stubbed.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { highlightStub } = await import('./helpers/highlight.mjs');
const reactUrl = import.meta.resolve('react');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');

async function compile(path, aliases = {}) {
  let { outputText } = ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
  for (const [specifier, url] of Object.entries({ react: reactUrl, 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), 'lucide-react': import.meta.resolve('lucide-react'), ...aliases })) outputText = outputText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
  return dataUrl(outputText);
}

// The same collapse the app uses (a conditional mount, not a height animation).
const motionStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const useCollapseAll = () => {};
export const Collapse = ({ open, children, className, id }) => open ? createElement('div', { className: 'content-collapse' }, createElement('div', { id, className }, children)) : null;
export const Disclosure = ({ open, heading, children, className }) => createElement('div', { className }, heading, open ? children : null);
`);
const nextuiStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const Button = ({ children, onPress, isDisabled, isLoading, endContent, ...rest }) => createElement('button', { type: 'button', disabled: !!isDisabled || !!isLoading, onClick: onPress, ...rest }, children, endContent);
`);
const uiStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const IconButton = ({ label, children, onClick, className }) => createElement('button', { type: 'button', 'aria-label': label, title: label, className: 'icon-button ' + (className || ''), onClick }, children);
`);
const markdownStub = dataUrl(`export default () => null;`);

const diff = await compile('../src/diff.ts');
const chat = await compile('../src/chat.ts');
const toolParams = await compile('../src/tool-params.ts');
const unifiedDiff = await compile('../src/components/UnifiedDiff.tsx', { '../diff': diff, '../highlight': highlightStub });
const { default: BlockRenderer } = await import(await compile('../src/components/BlockRenderer.tsx', {
  '../chat': chat, '../tool-params': toolParams, './Motion': motionStub, './ui': uiStub, './Markdown': markdownStub, './UnifiedDiff': unifiedDiff, '@nextui-org/react': nextuiStub,
}));

const change = (path, diff, additions, deletions) => ({ path, additions, deletions, diff });
const click = element => act(async () => element.click());

async function mount(changes, { onDiff, onRevert } = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const tree = list => createElement(BlockRenderer, { blocks: [{ id: 'changes', type: 'file_changes', changes: list }], notify: () => {}, onDiff, onRevert });
  await act(async () => root.render(tree(changes)));
  return {
    container,
    rows: () => [...container.querySelectorAll('.file-change-row')],
    lines: () => [...container.querySelectorAll('.unified-diff-line')].map(line => line.textContent),
    /** The block re-renders with a new patch list as the turn keeps working. */
    async update(next) { await act(async () => root.render(tree(next))); },
    async close() { await act(async () => root.unmount()); container.remove(); },
  };
}

const PATCH = '@@ -1,1 +1,2 @@\n-old\n+new\n+extra\n';

test('a single changed file expands its diff inside the message', async () => {
  const view = await mount([change('src/a.ts', PATCH, 2, 1)]);
  try {
    assert.equal(view.container.querySelector('.unified-diff'), null);
    const head = view.container.querySelector('.file-changes-main');
    assert.equal(head.getAttribute('aria-expanded'), 'false');
    await click(head);
    // The same rows the workspace pane renders: numbered, signed, one column.
    assert.deepEqual(view.lines(), ['1-old', '1+new', '2+extra']);
    assert.equal(head.getAttribute('aria-expanded'), 'true');
    await click(head);
    assert.equal(view.container.querySelector('.unified-diff'), null);
  } finally { await view.close(); }
});

test('each row of a multi-file change expands its own diff and can still open the pane', async () => {
  const opened = [];
  const view = await mount([change('src/a.ts', PATCH, 2, 1), change('src/b.ts', '@@ -5,0 +5,1 @@\n+added\n', 1, 0)], { onDiff: (path, diff) => opened.push([path, diff]) });
  try {
    assert.equal(view.rows().length, 2);
    await click(view.rows()[1].querySelector('.file-change-main'));
    // Only the clicked row expands, and it shows that file's patch.
    assert.deepEqual(view.lines(), ['5+added']);
    assert.deepEqual(view.container.querySelectorAll('.unified-diff').length, 1);
    await click(view.rows()[0].querySelector('.file-change-main'));
    assert.deepEqual(view.lines(), ['1-old', '1+new', '2+extra']);
    // The trailing button hands the stored patch to the workspace pane instead.
    await click(view.rows()[1].querySelector('.icon-button'));
    assert.deepEqual(opened, [['src/b.ts', '@@ -5,0 +5,1 @@\n+added\n']]);
  } finally { await view.close(); }
});

test('a file whose patch is missing cannot expand, and undoing closes the diff', async () => {
  const opened = [];
  const view = await mount([change('src/a.ts', undefined, 2, 1)], { onRevert: async () => {}, onDiff: (path, patch) => opened.push([path, patch]) });
  try {
    assert.equal(view.container.querySelector('.file-changes-main').disabled, true);
    assert.equal(view.container.querySelector('.unified-diff'), null);
    // Without a patch there is nothing to expand, but the pane still opens the
    // file: it falls back to reading the live Git diff there.
    await click(view.container.querySelector('.icon-button'));
    assert.deepEqual(opened, [['src/a.ts', undefined]]);
  } finally { await view.close(); }
  const undone = await mount([change('src/a.ts', PATCH, 2, 1)], { onRevert: async () => {}, onDiff: () => {} });
  try {
    await click(undone.container.querySelector('.file-changes-main'));
    assert.equal(undone.lines().length, 3);
    await click(undone.container.querySelector('.file-changes-undo'));
    assert.equal(undone.container.querySelector('.unified-diff'), null);
    assert.match(undone.container.querySelector('.file-changes-summary strong').textContent, /已撤销/);
  } finally { await undone.close(); }
});

test('an edit landing after an undo brings the card back', async () => {
  // The undo reverts the files, so a later edit to the same file is a *new* change
  // the card must show instead of staying stamped 已撤销 over a patch nobody reverted.
  const view = await mount([change('src/a.ts', PATCH, 2, 1)], { onRevert: async () => {}, onDiff: () => {} });
  const card = () => view.container.querySelector('.block-file-changes');
  try {
    await click(view.container.querySelector('.file-changes-main'));
    await click(view.container.querySelector('.file-changes-undo'));
    assert.equal(card().className.includes('undone'), true);
    await view.update([change('src/a.ts', `${PATCH}@@ -9,1 +10,1 @@\n-x\n+y\n`, 3, 2)]);
    assert.equal(card().className.includes('undone'), false);
    assert.equal(view.container.querySelector('.file-changes-summary strong').textContent, 'a.ts');
    // It comes back as the user left it — the diff they had open is open again —
    // and it is the patch just written, not the one that was undone.
    assert.deepEqual(view.lines(), ['1-old', '1+new', '2+extra', '9-x', '10+y']);
  } finally { await view.close(); }
});
