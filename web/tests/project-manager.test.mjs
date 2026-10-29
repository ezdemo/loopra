import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const reactUrl = import.meta.resolve('react');
const ui = dataUrl(`
import { createElement } from ${JSON.stringify(reactUrl)};
export const Button = ({ children, onPress, isDisabled, isLoading, isIconOnly, size, variant, color, ...rest }) => createElement('button', { type: 'button', disabled: !!isDisabled || !!isLoading, onClick: onPress, ...rest }, children);
export const Modal = ({ children, ...props }) => createElement('section', { role: 'dialog', 'aria-label': props['aria-label'] }, children);
export const ModalContent = ({ children }) => createElement('div', null, children);
export const ModalHeader = ({ children }) => createElement('header', null, children);
export const ModalBody = ({ children, ...props }) => createElement('div', props, children);
export const ModalFooter = ({ children }) => createElement('footer', null, children);
`);
const icons = dataUrl('export const ArrowDown = () => null, ArrowUp = () => null, FolderClosed = () => null, FolderPlus = () => null, GripVertical = () => null, RefreshCw = () => null, Trash2 = () => null;');
const source = await readFile(new URL('../src/components/ProjectManager.tsx', import.meta.url), 'utf8');
let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
for (const [specifier, url] of Object.entries({ react: reactUrl, 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), '@nextui-org/react': ui, 'lucide-react': icons })) outputText = outputText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
const { default: ProjectManager } = await import(dataUrl(outputText));
const projects = [{ hash: 'alpha', name: 'alpha', path: 'C:\\alpha' }, { hash: 'beta', name: 'beta', path: 'D:\\beta' }, { hash: 'gamma', name: 'gamma', path: 'D:\\gamma' }];
const button = label => document.querySelector(`[aria-label="${label}"]`);
const textButton = text => [...document.querySelectorAll('button')].find(item => item.textContent === text);
const order = () => [...document.querySelectorAll('[data-project-hash]')].map(item => item.dataset.projectHash);
const click = async element => act(async () => element.click());
async function mount({ fail, refreshFail = false, pending, selected = '', desktopPicker, canonicalPath } = {}) {
  if (desktopPicker) window.electronAPI = { loopraWebService: { pickFolder: desktopPicker } };
  else delete window.electronAPI;
  const calls = [], deleted = [], notices = [], entered = []; let saved = [...projects], refreshes = 0, closes = 0;
  const api = { async request(path, method, body) {
    calls.push({ path, method, body });
    if (pending) await pending;
    if (path === fail) throw new Error('保存失败');
    if (path === '/system/pick-directory') return selected;
    if (method === 'PUT') saved = body.map(hash => saved.find(item => item.hash === hash));
    if (method === 'POST') {
      const workspace = canonicalPath || body.path;
      if (!saved.some(item => item.path === workspace)) saved = [...saved, { hash: 'added', name: 'new-project', path: workspace }];
      return { workspace };
    }
    if (method === 'DELETE') saved = saved.filter(item => path !== `/workspaces/${item.hash}`);
  } };
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  await act(async () => root.render(createElement(ProjectManager, { api, workspaces: projects, current: 'alpha', sessions: [{ workspaceHash: 'alpha' }], onClose() { closes++; }, onRefresh: async () => { refreshes++; if (refreshFail) throw new Error('离线'); return saved; }, onAdded: item => entered.push(item.hash), onDeleted: item => deleted.push(item.hash), notify: message => notices.push(message) })));
  return { calls, deleted, notices, entered, closes: () => closes, refreshes: () => refreshes, async close() { await act(async () => root.unmount()); container.remove(); delete window.electronAPI; } };
}

test('Web folder selection automatically adds and enters the project', async () => {
  const view = await mount({ selected: 'C:\\工作项目' });
  try {
    await click(button('选择项目文件夹'));
    assert.deepEqual(view.calls, [
      { path: '/system/pick-directory', method: 'POST', body: { path: '' } },
      { path: '/workspace', method: 'POST', body: { path: 'C:\\工作项目' } },
    ]);
    assert.equal(view.refreshes(), 1);
    assert.deepEqual(view.entered, ['added']); assert.equal(view.closes(), 1);
  } finally { await view.close(); }
});

test('Electron uses the same Java picker and enters the canonical project returned by the backend', async () => {
  let picks = 0;
  const view = await mount({ desktopPicker: async () => { picks++; return 'D:\\native'; }, selected: 'c:\\ALPHA', canonicalPath: 'C:\\alpha' });
  try {
    await click(button('选择项目文件夹'));
    assert.equal(picks, 0);
    assert.equal(view.calls[0].path, '/system/pick-directory');
    assert.equal(view.calls[1].body.path, 'c:\\ALPHA');
    assert.deepEqual(view.entered, ['alpha']); assert.equal(view.closes(), 1);
    assert.deepEqual(order(), ['alpha', 'beta', 'gamma']);
  } finally { await view.close(); }
});

test('cancelling a Web folder selection preserves the typed path', async () => {
  const view = await mount();
  try {
    await act(async () => {
      const input = document.querySelector('input');
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, 'C:\\existing');
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await click(button('选择项目文件夹'));
    assert.equal(document.querySelector('input').value, 'C:\\existing');
    assert.equal(view.calls[0].body.path, 'C:\\existing');
    assert.equal(view.calls.length, 1); assert.equal(view.refreshes(), 0);
    assert.deepEqual(view.entered, []); assert.equal(view.closes(), 0);
  } finally { await view.close(); }
});

test('failed Web pickers show the error and allow another attempt', async () => {
  const view = await mount({ fail: '/system/pick-directory' });
  try {
    await click(button('选择项目文件夹'));
    assert.match(document.querySelector('[role="alert"]').textContent, /保存失败/);
    assert.equal(button('选择项目文件夹').disabled, false);
  } finally { await view.close(); }
});

test('failed project additions retain the selected path without entering or closing', async () => {
  const view = await mount({ selected: 'D:\\project', fail: '/workspace' });
  try {
    await click(button('选择项目文件夹'));
    assert.match(document.querySelector('[role="alert"]').textContent, /保存失败/);
    assert.equal(document.querySelector('input').value, 'D:\\project');
    assert.deepEqual(view.entered, []); assert.equal(view.closes(), 0);
    assert.equal(button('选择项目文件夹').disabled, false);
  } finally { await view.close(); }
});

test('failed refresh after selection keeps the dialog open and reports the saved addition', async () => {
  const view = await mount({ selected: 'D:\\project', refreshFail: true });
  try {
    await click(button('选择项目文件夹'));
    assert.match(document.querySelector('[role="alert"]').textContent, /操作已保存，刷新项目失败/);
    assert.deepEqual(view.entered, []); assert.equal(view.closes(), 0);
  } finally { await view.close(); }
});
async function drag(from, to) {
  const dataTransfer = { effectAllowed: '', dropEffect: '', setData() {} };
  const fire = (element, type) => { const event = new dom.window.Event(type, { bubbles: true, cancelable: true }); Object.defineProperty(event, 'dataTransfer', { value: dataTransfer }); element.dispatchEvent(event); };
  await act(async () => fire(button(`拖动排序 ${from}`), 'dragstart'));
  await act(async () => fire(document.querySelector(`[data-project-hash="${to}"]`), 'drop'));
}

test('dragging persists the complete new order, with keyboard controls as an alternative', async () => {
  const view = await mount();
  try {
    await drag('alpha', 'gamma');
    assert.deepEqual(view.calls[0], { path: '/workspaces/order', method: 'PUT', body: ['beta', 'gamma', 'alpha'] });
    assert.deepEqual(order(), ['beta', 'gamma', 'alpha']);
    await click(button('上移 alpha'));
    assert.deepEqual(order(), ['beta', 'alpha', 'gamma']);
    assert.equal(view.refreshes(), 2);
  } finally { await view.close(); }
});
test('failed ordering restores the list and reports the error', async () => {
  const view = await mount({ fail: '/workspaces/order' });
  try { await drag('alpha', 'gamma'); assert.deepEqual(order(), ['alpha', 'beta', 'gamma']); assert.match(document.querySelector('[role="alert"]').textContent, /保存失败/); assert.equal(view.refreshes(), 0); }
  finally { await view.close(); }
});
test('adding trims the absolute path and refreshes the list', async () => {
  const view = await mount();
  try {
    await act(async () => { const input = document.querySelector('input'); Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, '  C:\\new-project  '); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    await act(async () => document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
    assert.deepEqual(view.calls[0], { path: '/workspace', method: 'POST', body: { path: 'C:\\new-project' } });
    assert.deepEqual(order(), ['alpha', 'beta', 'gamma', 'added']); assert.equal(document.querySelector('input').value, '');
    assert.deepEqual(view.entered, ['added']); assert.equal(view.closes(), 1);
  } finally { await view.close(); }
});
test('removing requires confirmation, scopes the endpoint and informs the parent', async () => {
  const view = await mount();
  try {
    await click(button('移除 alpha')); assert.deepEqual(view.calls, []);
    assert.match(document.querySelector('[role="alertdialog"]').textContent, /磁盘上的文件不会被删除/);
    await click(textButton('取消')); assert.deepEqual(view.calls, []);
    await click(button('移除 alpha')); await click(textButton('确认移除'));
    assert.deepEqual(view.calls, [{ path: '/workspaces/alpha', method: 'DELETE', body: undefined }]);
    assert.deepEqual(view.deleted, ['alpha']); assert.deepEqual(order(), ['beta', 'gamma']);
  } finally { await view.close(); }
});
test('a failed refresh after deletion never offers to delete the same project again', async () => {
  const view = await mount({ refreshFail: true });
  try {
    await click(button('移除 beta')); await click(textButton('确认移除'));
    assert.deepEqual(order(), ['alpha', 'gamma']); assert.equal(document.querySelector('[role="alertdialog"]'), null);
    assert.match(document.querySelector('[role="alert"]').textContent, /操作已保存，刷新项目失败/);
  } finally { await view.close(); }
});
test('pending requests disable other project mutations', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; }); const view = await mount({ pending });
  try {
    await click(button('下移 alpha'));
    assert.equal(button('移除 beta').disabled, true); assert.equal(button('拖动排序 beta').draggable, false);
    await act(async () => release()); assert.equal(view.calls.length, 1);
  } finally { release(); await view.close(); }
});
