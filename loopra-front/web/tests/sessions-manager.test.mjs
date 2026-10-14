import { fieldStubs, checkboxStub } from './helpers/form-controls.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// The session manager deletes server data, so assert the exact endpoints and
// payloads instead of touching a live backend.
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
dom.window.URL.createObjectURL ||= () => 'blob:stub';
dom.window.URL.revokeObjectURL ||= () => {};
dom.window.HTMLAnchorElement.prototype.click = () => {};

const nextuiStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const Button = ({ children, onPress, isDisabled, isLoading, ...rest }) => createElement('button', { type: 'button', disabled: !!isDisabled || !!isLoading, onClick: onPress, ...rest }, children);
export const Modal = ({ children }) => createElement('div', { role: 'dialog' }, children);
export const ModalContent = ({ children }) => createElement('div', null, children);
${checkboxStub}
`);
const iconsStub = dataUrl('export const Activity=()=>null;export const Clock=()=>null;export const Download=()=>null;export const MessageCircle=()=>null;export const Plus=()=>null;export const RefreshCw=()=>null;export const Trash2=()=>null;export const Wrench=()=>null;');
const confirmStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const query = values => new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])).toString();
export function ConfirmAction({ title, children, action, onClose, onDone }) {
  return createElement('div', { role: 'alertdialog', 'aria-label': title }, children,
    createElement('button', { type: 'button', onClick: async () => { await action(); onDone?.(); onClose(); } }, '确认'));
}
`);
const usageStub = dataUrl('export const usagePath = (workspaceHash, sessionName) => `/usage?workspaceHash=${workspaceHash}${sessionName ? `&sessionName=${sessionName}` : ""}`;');
const statsUrl = await sourceUrl('session-stats.ts');

const Manager = (await import(await sourceUrl('components/SessionsManager.tsx', {
  '@nextui-org/react': nextuiStub,
  './SettingControls': dataUrl(`const { createElement } = await import(${JSON.stringify(reactUrl)}); ${fieldStubs}`),
  'lucide-react': iconsStub,
  './RemoteControls': confirmStub,
  '../session-stats': statsUrl,
  '../usage': usageStub,
}))).default;

const sessions = [
  { id: 'aaa/one', name: 'one', workspaceHash: 'aaa', title: '修复登录', workspace: 'alpha', messageCount: 12, mtime: Date.UTC(2026, 0, 2, 3, 4), worktreeMode: true },
  { id: 'aaa/two', name: 'two', workspaceHash: 'aaa', title: 'Add tests', workspace: 'alpha', messageCount: 8, mtime: Date.UTC(2026, 0, 3, 5, 6) },
];

async function mount({ sessionList = sessions, workspaceHash = 'aaa', onChanged = async () => {}, failDelete = '' } = {}) {
  globalThis.__calls = []; globalThis.__events = [];
  const api = {
    request: (path, method = 'GET', body) => {
      globalThis.__calls.push({ path, method, body });
      if (method === 'DELETE' && failDelete && path.startsWith(`/sessions/${failDelete}?`)) return Promise.reject(new Error('后端删除失败'));
      return Promise.resolve(path.startsWith('/usage') ? { totalTokens: 2500 } : 'ok');
    },
  };
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Manager, {
    api, sessions: sessionList, workspaceHash, workspaceName: 'alpha', activeId: 'aaa/one',
    onClose: () => globalThis.__events.push('close'),
    onOpen: id => globalThis.__events.push(`open:${id}`),
    onNew: () => globalThis.__events.push('new'),
    onChanged, notify: message => globalThis.__events.push(`notify:${message}`),
  })));
  return { container, root, async close() { await act(async () => root.unmount()); container.remove(); } };
}
const buttonIn = (element, text) => [...element.querySelectorAll('button')].find(candidate => candidate.textContent.includes(text));
async function click(element) { await act(async () => { element.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); }
async function type(element, value) {
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  await act(async () => { setValue.call(element, value); element.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
}

test('summary cards reuse the legacy formulas and the usage endpoint', async () => {
  const view = await mount();
  const text = view.container.textContent;
  assert.match(text, /2 个会话 · alpha/);
  assert.match(text, /总消息数/); assert.match(text, /20/);
  assert.match(text, /工具调用/); assert.match(text, /12/);
  assert.match(text, /2h 0m/);
  assert.match(text, /2\.5K/);
  const usage = globalThis.__calls.find(call => call.path.startsWith('/usage'));
  assert.deepEqual(usage, { path: '/usage?workspaceHash=aaa', method: 'GET', body: undefined });
  await view.close();
});

test('search filters the list and resets paging', async () => {
  const view = await mount();
  assert.match(view.container.textContent, /修复登录/);
  await type(view.container.querySelector('input[aria-label="搜索会话"]'), 'add tests');
  const text = view.container.textContent;
  assert.match(text, /Add tests/);
  assert.ok(!text.includes('修复登录'), 'non-matching sessions are hidden');
  await view.close();
});

test('paging splits a long list', async () => {
  const many = Array.from({ length: 12 }, (_, index) => ({ id: `aaa/s${index}`, name: `s${index}`, workspaceHash: 'aaa', title: `会话 ${index}`, workspace: 'alpha', messageCount: index }));
  const view = await mount({ sessionList: many });
  assert.match(view.container.textContent, /第 1 页，共 2 页/);
  await click(buttonIn(view.container, '下一页'));
  assert.match(view.container.textContent, /第 2 页，共 2 页/);
  await view.close();
});

test('loading a card opens that session and export downloads JSON', async () => {
  const view = await mount();
  await click(buttonIn(view.container, '加载'));
  assert.ok(globalThis.__events.includes('open:aaa/one'));
  await click(buttonIn(view.container, '导出'));
  assert.ok(globalThis.__events.some(event => event.startsWith('notify:会话') && event.includes('已导出')));
  await view.close();
});

test('deleting a card confirms then hits the scoped session endpoint', async () => {
  const view = await mount();
  await click(buttonIn(view.container.querySelector('.sessions-manager-card'), '删除'));
  assert.ok(view.container.querySelector('[role="alertdialog"]'), 'a confirmation is shown first');
  await click(buttonIn(view.container.querySelector('[role="alertdialog"]'), '确认'));
  assert.deepEqual(globalThis.__calls.filter(call => call.method === 'DELETE'), [{ path: '/sessions/one?workspaceHash=aaa', method: 'DELETE', body: undefined }]);
  assert.ok(globalThis.__events.includes('notify:会话 修复登录 已删除'));
  await view.close();
});

test('clearing wipes only the active workspace after confirmation', async () => {
  const view = await mount();
  await click(buttonIn(view.container, '清空当前工作区'));
  await click(buttonIn(view.container.querySelector('[role="alertdialog"]'), '确认'));
  assert.deepEqual(globalThis.__calls.filter(call => call.method === 'DELETE'), [{ path: '/sessions?workspaceHash=aaa', method: 'DELETE', body: undefined }]);
  assert.ok(globalThis.__events.includes('notify:当前工作区会话已清空'));
  await view.close();
});

// Legacy DesktopHome multi-select + DesktopShell.performDeleteSessions.
test('selecting cards deletes them one by one and reports the batch result', async () => {
  const view = await mount();
  const boxes = [...view.container.querySelectorAll('input[type="checkbox"]')];
  assert.equal(boxes.length, 2);
  await click(boxes[0]);
  await click(boxes[1]);
  assert.ok(view.container.textContent.includes('删除选中 (2)'));
  await click(buttonIn(view.container, '删除选中'));
  const dialog = view.container.querySelector('[role="alertdialog"]');
  assert.match(dialog.textContent, /修复登录、Add tests将被永久删除/);
  await click(buttonIn(dialog, '确认'));
  assert.deepEqual(globalThis.__calls.filter(call => call.method === 'DELETE').map(call => call.path), [
    '/sessions/one?workspaceHash=aaa',
    '/sessions/two?workspaceHash=aaa',
  ]);
  assert.ok(globalThis.__events.includes('notify:已删除 2 个会话'));
  await view.close();
});

test('a failing entry in the batch keeps the successful deletions and reports the rest', async () => {
  const view = await mount({ failDelete: 'two' });
  for (const box of view.container.querySelectorAll('input[type="checkbox"]')) await click(box);
  await click(buttonIn(view.container, '删除选中'));
  await click(buttonIn(view.container.querySelector('[role="alertdialog"]'), '确认'));
  assert.ok(globalThis.__events.includes('notify:已删除 1 个会话，1 个失败：Add tests'));
  // The failed session stays selected so it can be retried.
  assert.ok(view.container.textContent.includes('删除选中 (1)'));
  await view.close();
});

test('全选 toggles every session and can be cleared again', async () => {
  const view = await mount();
  await click(buttonIn(view.container, '全选'));
  assert.ok(view.container.textContent.includes('删除选中 (2)'));
  assert.ok(view.container.textContent.includes('取消全选'));
  await click(buttonIn(view.container, '取消全选'));
  assert.ok(view.container.textContent.includes('删除选中 (0)'));
  assert.ok(buttonIn(view.container, '删除选中').disabled, 'the batch button is disabled with an empty selection');
  await view.close();
});

test('refresh and new-session are delegated to the app shell', async () => {
  let refreshed = 0;
  const view = await mount({ onChanged: async () => { refreshed += 1; } });
  await click(buttonIn(view.container, '刷新'));
  assert.equal(refreshed, 1);
  assert.ok(globalThis.__events.includes('notify:会话列表已刷新'));
  await click(buttonIn(view.container, '新建会话'));
  assert.ok(globalThis.__events.includes('new'));
  await view.close();
});
