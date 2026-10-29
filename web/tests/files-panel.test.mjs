import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// The workspace file panel deletes server files, so assert the exact endpoints
// and the tree / search / preview wiring against stubs instead of a live backend.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const reactUrl = import.meta.resolve('react');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
async function sourceUrl(name, dependencies = {}) {
  const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
  for (const [specifier, url] of Object.entries({ react: reactUrl, 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), ...dependencies })) {
    outputText = outputText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
  }
  return dataUrl(outputText);
}

const nextuiStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const Button = ({ children, onPress, isDisabled, isLoading, ...rest }) => createElement('button', { type: 'button', disabled: !!isDisabled || !!isLoading, onClick: onPress, ...rest }, children);
`);
const iconNames = ['ChevronRight', 'ChevronsDownUp', 'Coffee', 'Container', 'Database', 'ExternalLink', 'FileArchive', 'FileCode', 'FileImage', 'FileJson', 'FileText', 'FolderClosed', 'FolderOpen', 'GitBranch', 'ListTree', 'Package', 'Palette', 'Pencil', 'RefreshCw', 'Search', 'Settings', 'Terminal', 'Trash2', 'X'];
const iconsStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
const make = () => props => createElement('svg', props);
${iconNames.map(name => `export const ${name} = make();`).join('')}
`);
const uiStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const IconButton = ({ label, children, onClick }) => createElement('button', { type: 'button', 'aria-label': label, onClick }, children);
`);
const controlsStub = dataUrl(`
const React = await import(${JSON.stringify(reactUrl)});
export const errorText = cause => cause instanceof Error ? cause.message : String(cause);
export const query = values => new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])).toString();
export function useRemote(api, path, revision = 0) {
  const [state, setState] = React.useState({ data: undefined, error: '', loading: !!path });
  React.useEffect(() => {
    let live = true;
    setState({ data: undefined, error: '', loading: !!path });
    if (!path) return undefined;
    api.request(path, 'GET').then(data => { if (live) setState({ data, error: '', loading: false }); })
      .catch(error => { if (live) setState({ data: undefined, error: errorText(error), loading: false }); });
    return () => { live = false; };
  }, [api, path, revision]);
  return state;
}
export function ConfirmAction({ title, children, action, onClose, onDone }) {
  return React.createElement('div', { role: 'alertdialog', 'aria-label': title }, children,
    React.createElement('button', { type: 'button', onClick: async () => { await action(); onDone?.(); onClose(); } }, '确认'));
}
`);
const diffStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export default ({ diff }) => createElement('pre', { className: 'stub-diff' }, diff || '');
`);

const Panel = (await import(await sourceUrl('components/FilesPanel.tsx', {
  '@nextui-org/react': nextuiStub,
  'lucide-react': iconsStub,
  './ui': uiStub,
  './RemoteControls': controlsStub,
  './DiffView': diffStub,
  // 真实的能力探测模块：重命名 / 在文件管理器中显示只在 Electron 桥存在时出现。
  '../desktop-files': await sourceUrl('desktop-files.ts'),
  // 真实 git 装饰映射：文件树用它渲染 M/A/D/U 徽标。
  '../git-decorations': await sourceUrl('git-decorations.ts'),
  // 文件树与变更列表复用同一个文件类型图标组件。
  './FileGlyph': await sourceUrl('components/FileGlyph.tsx', {
    'lucide-react': iconsStub,
    '../file-icons': await sourceUrl('file-icons.ts'),
  }),
}))).default;

const roots = [
  { name: 'src', path: 'src', directory: true },
  { name: 'README.md', path: 'README.md', directory: false },
];
const srcChildren = [{ name: 'a.txt', path: 'src/a.txt', directory: false }];

async function mount({ status = 'ok' } = {}) {
  globalThis.__calls = []; globalThis.__added = []; globalThis.__opened = [];
  const api = {
    request: (path, method = 'GET') => {
      globalThis.__calls.push({ path, method });
      if (path.startsWith('/files/tree?')) return Promise.resolve(path.includes('path=src') ? srcChildren : roots);
      if (path.startsWith('/files/search?')) return Promise.resolve([{ name: 'index.ts', path: 'src/index.ts', directory: false }]);
      if (path.startsWith('/git/working-file-content?')) return Promise.resolve({ content: 'hello\nworld', exists: true });
      if (path.startsWith('/git/diff-content?')) return Promise.resolve({ diff: '@@ -1,1 +1,1 @@\n-old\n+new', stat: '' });
      if (path.startsWith('/git/status?')) return Promise.resolve(status);
      return Promise.resolve('ok');
    },
  };
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Panel, {
    api, workspaceHash: 'hash1', revision: 0,
    onAdd: (path, selection) => globalThis.__added.push({ path, selection }),
    onOpen: path => globalThis.__opened.push(path),
  })));
  return { container, root, async close() { await act(async () => root.unmount()); container.remove(); } };
}
const buttonIn = (element, text) => [...element.querySelectorAll('button')].find(candidate => candidate.textContent.includes(text));
async function click(element) { await act(async () => { element.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); }

test('loads the directory tree on demand and opens a file in the main workspace', async () => {
  const view = await mount();
  try {
    assert.deepEqual(globalThis.__calls[0], { path: '/files/tree?workspaceHash=hash1', method: 'GET' });
    assert.ok(view.container.textContent.includes('README.md'));
    await click(buttonIn(view.container, 'src'));
    assert.ok(globalThis.__calls.some(call => call.path === '/files/tree?workspaceHash=hash1&path=src'));
    await click(buttonIn(view.container, 'a.txt'));
    assert.deepEqual(globalThis.__opened, ['src/a.txt']);
    assert.equal(view.container.querySelector('.workspace-preview'), null);
  } finally { await view.close(); }
});

test('collapse all clears every expanded directory', async () => {
  const view = await mount();
  try {
    // 未展开时没有「折叠全部」按钮。
    assert.equal(view.container.querySelector('.collapse-tree'), null);
    await click(buttonIn(view.container, 'src'));
    assert.ok(view.container.textContent.includes('a.txt'), '展开后能看到子节点');
    const collapse = view.container.querySelector('.collapse-tree');
    assert.ok(collapse, '展开后出现「折叠全部」');
    await click(collapse);
    assert.ok(!view.container.textContent.includes('a.txt'), '折叠后子节点隐藏');
    assert.equal(view.container.querySelector('.collapse-tree'), null, '没有展开目录时按钮消失');
    assert.ok(view.container.textContent.includes('README.md'), '顶层条目仍在');
  } finally { await view.close(); }
});

test('recursive search opens its result in the main workspace', async () => {
  const view = await mount();
  try {
    const input = view.container.querySelector('input[aria-label="筛选文件"]');
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    await act(async () => { setValue.call(input, 'index'); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
    assert.ok(globalThis.__calls.some(call => call.path === '/files/search?workspaceHash=hash1&query=index'));
    await click(buttonIn(view.container, 'index.ts'));
    assert.deepEqual(globalThis.__opened, ['src/index.ts']);
  } finally { await view.close(); }
});

test('deleting from the context menu confirms and hits the delete endpoint', async () => {
  const view = await mount();
  try {
    const file = buttonIn(view.container, 'README.md');
    await act(async () => { file.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })); });
    await click(buttonIn(view.container.querySelector('.file-context-menu'), '删除'));
    await click([...view.container.querySelectorAll('[role="alertdialog"] button')].find(button => button.textContent.trim() === '确认'));
    const removed = globalThis.__calls.find(call => call.method === 'DELETE');
    assert.equal(removed.path, '/files/delete?workspaceHash=hash1&path=README.md');
  } finally { await view.close(); }
});

test('the context menu adds files to the session independently of opening them', async () => {
  const view = await mount();
  try {
    const menu = await openContextMenu(view.container, 'README.md');
    await click(buttonIn(menu, '添加到上下文'));
    assert.deepEqual(globalThis.__added, [{ path: 'README.md', selection: undefined }]);
  } finally { await view.close(); }
});

async function openContextMenu(container, name) {
  const file = buttonIn(container, name);
  await act(async () => { file.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })); });
  return container.querySelector('.file-context-menu');
}

test('rename and reveal stay hidden without the Electron bridge', async () => {
  const view = await mount();
  try {
    const menu = await openContextMenu(view.container, 'README.md');
    assert.ok(menu.textContent.includes('删除'));
    assert.ok(!menu.textContent.includes('重命名'), '浏览器版没有 rename IPC');
    assert.ok(!menu.textContent.includes('在文件管理器中显示'));
  } finally { await view.close(); }
});

test('the desktop bridge reveals the file manager and renames inline', async () => {
  const renamed = [];
  const revealed = [];
  dom.window.electronAPI = {
    fileExplorer: { rename: async (path, name) => { renamed.push([path, name]); return { success: true, data: { name, path: name } }; } },
    openFolder: async path => { revealed.push(path); return { success: true }; },
  };
  const view = await mount();
  try {
    const menu = await openContextMenu(view.container, 'README.md');
    assert.ok(menu.textContent.includes('重命名'));
    await click(buttonIn(menu, '在文件管理器中显示'));
    assert.deepEqual(revealed, ['README.md']);

    await openContextMenu(view.container, 'README.md');
    await click(buttonIn(view.container.querySelector('.file-context-menu'), '重命名'));
    const input = view.container.querySelector('.tree-rename-input');
    assert.ok(input, '重命名会就地展开输入框');
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    await act(async () => { setValue.call(input, 'main.md'); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    await act(async () => { input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await Promise.resolve(); });
    assert.deepEqual(renamed, [['README.md', 'main.md']]);
    assert.ok(view.container.textContent.includes('main.md'), '树里的名字跟着更新');
    assert.ok(!view.container.textContent.includes('README.md'), view.container.textContent);
  } finally { delete dom.window.electronAPI; await view.close(); }
});

test('the tree shows git status decorations from /git/status', async () => {
  const view = await mount({ status: { initialized: true, changed: [{ path: 'README.md', status: 'M' }, { path: 'src/a.txt', status: 'A' }], untracked: [] } });
  try {
    const readme = buttonIn(view.container, 'README.md');
    assert.ok(readme, 'README row renders');
    assert.ok(readme.className.includes('decorated') && readme.className.includes('is-modified'), readme.className);
    assert.equal(readme.querySelector('.fen-decoration')?.textContent, 'M', 'file shows the modified letter');

    const src = buttonIn(view.container, 'src');
    assert.ok(src.className.includes('decorated') && src.className.includes('is-added'), src.className);
    assert.ok(src.querySelector('.fen-decoration.is-directory'), 'ancestor directory gets a tinting dot');
  } finally { await view.close(); }
});

test('no decorations are rendered before git is initialized', async () => {
  const view = await mount({ status: { initialized: false, changed: [{ path: 'README.md', status: 'M' }], untracked: [] } });
  try {
    assert.equal(view.container.querySelector('.fen-decoration'), null);
    assert.ok(!buttonIn(view.container, 'README.md').className.includes('decorated'));
  } finally { await view.close(); }
});

test('file rows pick a per-extension icon like the legacy explorer', async () => {
  const view = await mount();
  try {
    const readme = buttonIn(view.container, 'README.md');
    assert.equal(readme.querySelector('[data-icon]')?.getAttribute('data-icon'), 'markdown');
    await click(buttonIn(view.container, 'src'));
    assert.equal(buttonIn(view.container, 'a.txt').querySelector('[data-icon]')?.getAttribute('data-icon'), 'default');
  } finally { await view.close(); }
});
