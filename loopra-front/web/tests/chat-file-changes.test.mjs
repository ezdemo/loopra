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
const markdownStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export default ({ onOpenFile }) => createElement('button', { className: 'markdown-file-link', onClick: () => onOpenFile?.('src/a.ts') }, 'file');
`);

const diff = await compile('../src/diff.ts');
const chat = await compile('../src/chat.ts');
const toolParams = await compile('../src/tool-params.ts');
const unifiedDiff = await compile('../src/components/UnifiedDiff.tsx', { '../diff': diff, '../highlight': highlightStub });
const imagePreview = await compile('../src/components/ImagePreview.tsx', { 'react-dom': import.meta.resolve('react-dom') });
const { ImagePreviewProvider } = await import(imagePreview);
const toolImageResult = await compile('../src/components/ToolImageResult.tsx', { './ImagePreview': imagePreview });
const { ToolImageSourceProvider } = await import(toolImageResult);
const fileGlyph = await compile('../src/components/FileGlyph.tsx', { '../file-icons': await compile('../src/file-icons.ts') });
const { default: BlockRenderer } = await import(await compile('../src/components/BlockRenderer.tsx', {
  '../chat': chat, '../tool-params': toolParams, './Motion': motionStub, './ui': uiStub, './Markdown': markdownStub, './UnifiedDiff': unifiedDiff, './ToolImageResult': toolImageResult, './FileGlyph': fileGlyph, '@nextui-org/react': nextuiStub,
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
    assert.equal(head.querySelector('[data-icon]').getAttribute('data-icon'), 'typescript');
    assert.equal(head.getAttribute('aria-expanded'), 'false');
    await click(head);
    // The same rows the workspace pane renders: numbered, signed, one column.
    assert.deepEqual(view.lines(), ['1-old', '1+new', '2+extra']);
    assert.equal(head.getAttribute('aria-expanded'), 'true');
    await click(head);
    assert.equal(view.container.querySelector('.unified-diff'), null);
  } finally { await view.close(); }
});

test('ordinary file links and tool file paths open the content callback', async () => {
  const opened = [];
  const diffs = [];
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(BlockRenderer, {
      blocks: [
        { id: 'answer', type: 'content', content: '[src/a.ts](src/a.ts)' },
        { id: 'tool', type: 'tool_call', name: 'edit', args: { file_path: 'src/a.ts' }, status: '成功' },
      ],
      notify: () => {},
      onOpenFile: path => opened.push(path),
      onDiff: path => diffs.push(path),
    })));
    await click(container.querySelector('.markdown-file-link'));
    await click(container.querySelector('.tool-file'));
    assert.deepEqual(opened, ['src/a.ts', 'src/a.ts']);
    assert.deepEqual(diffs, []);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
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
    assert.equal(view.rows()[1].querySelector('.icon-button').getAttribute('aria-label'), '打开文件 b.ts');
    assert.ok(view.rows()[1].querySelector('.icon-button .lucide-file-symlink'));
    await click(view.rows()[1].querySelector('.icon-button'));
    assert.deepEqual(opened, [['src/b.ts', '@@ -5,0 +5,1 @@\n+added\n']]);
  } finally { await view.close(); }
});

test('file change rows share the file tree glyphs for Java, YAML and special file names', async () => {
  const view = await mount([
    change('src/Main.java', PATCH, 2, 1),
    change('config/app.yml', PATCH, 2, 1),
    change('C:\\workspace\\pom.xml', PATCH, 2, 1),
  ]);
  try {
    assert.deepEqual(view.rows().map(row => row.querySelector('[data-icon]').getAttribute('data-icon')), ['java', 'yaml', 'maven']);
    assert.ok(view.rows()[0].querySelector('.lucide-coffee'));
    assert.ok(view.rows()[1].querySelector('.lucide-list-tree'));
    assert.ok(view.rows()[2].querySelector('.lucide-package'));
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


test('the exact View Image title from the screenshot renders its path as an image inside the tool detail', async () => {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const path = 'C:\\Users\\15614\\Downloads\\1792912429871.png';
  const title = `View Image ${path}`;
  const previousFetch = globalThis.fetch;
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  const requests = [], revoked = [];
  globalThis.fetch = async url => { requests.push(String(url)); return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } }); };
  URL.createObjectURL = () => 'blob:test-image'; URL.revokeObjectURL = url => revoked.push(url);
  const render = async status => act(async () => root.render(createElement(ImagePreviewProvider, null,
    createElement(ToolImageSourceProvider, { value: source => `http://test.invalid/api/files/image?path=${encodeURIComponent(source)}` },
      createElement(BlockRenderer, { notify() {}, blocks: [{ id: 'read', type: 'tool_call', name: title, status, args: { path } }] })))));
  try {
    await render('执行中');
    assert.equal(host.querySelector('.tool-head').getAttribute('aria-expanded'), 'false');
    assert.equal(requests.length, 0);
    await render('成功');
    assert.equal(host.querySelector('.tool-name').textContent, title, 'the existing tool header remains');
    assert.equal(host.querySelector('.tool-head').getAttribute('aria-expanded'), 'true', 'successful image reads open automatically');
    assert.equal(host.querySelector('.tool-image-heading'), null);
    assert.equal(host.querySelector('.tool-detail pre'), null, 'the raw parameter JSON is replaced only for image readers');
    assert.equal(host.querySelector('.tool-image-thumbnail img').getAttribute('src'), 'blob:test-image');
    assert.equal(new URL(requests[0]).searchParams.get('path'), path);
    await click(host.querySelector('.tool-image-thumbnail'));
    assert.equal(document.querySelector('.image-preview-full').getAttribute('src'), 'blob:test-image');
    await click(document.querySelector('[aria-label="关闭图片预览"]'));
    await click(host.querySelector('.tool-head'));
    assert.equal(host.querySelector('.tool-image-result'), null, 'an image read can still be collapsed manually');
    await render('执行中');
    await render('成功');
    assert.equal(host.querySelector('.tool-image-result'), null, 'stream updates respect a manual collapse');
    await click(host.querySelector('.tool-head'));
    await render('失败');
    assert.equal(host.querySelector('.tool-image-result'), null);
    assert.ok(host.querySelector('.tool-detail pre'), 'failed reads keep their original diagnostic detail');
  } finally {
    await act(async () => root.unmount()); host.remove(); globalThis.fetch = previousFetch;
    URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
  }
  assert.ok(revoked.includes('blob:test-image'));
});
