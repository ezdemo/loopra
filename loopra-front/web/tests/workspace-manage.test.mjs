import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// The workspace / session maintenance screen deletes server data, so assert the
// exact endpoints and bodies instead of exercising a live backend.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLSelectElement: dom.window.HTMLSelectElement, IS_REACT_ACT_ENVIRONMENT: true };
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
export const Button = ({ children, onPress, isDisabled, isLoading, isIconOnly, size, variant, color, ...rest }) =>
  createElement('button', { type: 'button', disabled: !!isDisabled || !!isLoading, onClick: onPress, ...rest }, children);
export const Spinner = () => null;
`);
const controlsStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const PageHeader = ({ title, children }) => createElement('header', null, title, children);
export const SettingRow = ({ title, description, children }) => createElement('div', { className: 'row' }, createElement('span', { className: 'row-title' }, title), description ? createElement('small', null, description) : null, children);
export const SettingSwitch = () => null;
export const EmptySetting = ({ children }) => createElement('div', { className: 'empty' }, children);
export const Field = ({ label, value, onChange }) => createElement('input', { 'aria-label': label, value, onChange: event => onChange(event.target.value) });
`);
const confirmStub = dataUrl(`
const React = await import(${JSON.stringify(reactUrl)});
export function ConfirmAction({ title, children, action, onClose, onDone }) {
  return React.createElement('div', { role: 'dialog' }, React.createElement('h2', null, title), children,
    React.createElement('button', { type: 'button', onClick: async () => { await action(); onDone?.(); onClose(); } }, '确认'));
}
`);
const backendStub = dataUrl(`
export class LoopraClient {
  constructor(base) { this.base = base; }
  request(path, method = 'GET', body) {
    globalThis.__calls.push({ path, method, body });
    const failing = globalThis.__failPath && path.startsWith(globalThis.__failPath) ? globalThis.__failPath + 'aaa111' : null;
    if (failing && path.includes('aaa111')) return Promise.reject(new Error('cleanup failed for aaa111'));
    return Promise.resolve('ok');
  }
}
export const serverAddress = value => value;
`);
const projectsUrl = await sourceUrl('components/BackendSettings.tsx', { '@nextui-org/react': nextuiStub, './SettingControls': controlsStub, './RemoteControls': confirmStub, '../backend': backendStub, 'lucide-react': dataUrl('export const RefreshCw = () => null;') });
const { BackendProjects } = await import(projectsUrl);

const workspaces = [{ hash: 'aaa111', name: 'alpha', path: 'C:\\alpha' }, { hash: 'bbb222', name: 'beta', path: 'D:\\beta' }];
const sessions = [{ workspaceHash: 'aaa111' }, { workspaceHash: 'aaa111' }, { workspaceHash: 'bbb222' }];
const row = title => [...document.querySelectorAll('.row')].find(element => element.querySelector('.row-title')?.textContent === title);
const buttonIn = (element, text) => [...element.querySelectorAll('button')].find(candidate => candidate.textContent.trim() === text);

async function mount(initialWorkspaces = workspaces, initialSessions = sessions) {
  globalThis.__calls = [];
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  let refreshes = 0;
  // The parent re-fetches workspaces after a mutation, so expose a render()
  // that replays the new order the way App would.
  const render = async (nextWorkspaces = initialWorkspaces, nextSessions = initialSessions) =>
    act(async () => root.render(createElement(BackendProjects, { server: 'http://127.0.0.1:4567', workspaces: nextWorkspaces, sessions: nextSessions, onRefresh: async () => { refreshes++; } })));
  await render();
  return { container, root, render, calls: () => globalThis.__calls, refreshes: () => refreshes, async close() { await act(async () => root.unmount()); container.remove(); } };
}
async function click(element) { await act(async () => { element.click(); await Promise.resolve(); await Promise.resolve(); }); }

test('workspace ordering persists the swapped hash list', async () => {
  const view = await mount();
  try {
    assert.equal(row('alpha').querySelector('.row-title').textContent, 'alpha');
    await click(buttonIn(row('alpha'), '↓'));
    const order = view.calls().find(call => call.path === '/workspaces/order');
    assert.deepEqual(order, { path: '/workspaces/order', method: 'PUT', body: ['bbb222', 'aaa111'] });
    // Once App re-renders with the persisted order, alpha is no longer first so
    // its "move up" control becomes available again.
    assert.equal(row('alpha').querySelector('button').disabled, true);
    await view.render([workspaces[1], workspaces[0]]);
    assert.equal(row('alpha').querySelector('button').disabled, false);
  } finally { await view.close(); }
});

test('clearing a workspace and removing a project hit the scoped session and project endpoints', async () => {
  const view = await mount();
  try {
    await click(buttonIn(row('beta'), '清空会话'));
    await click([...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.trim() === '确认'));
    const cleared = view.calls().find(call => call.method === 'DELETE' && call.path.startsWith('/sessions?'));
    assert.equal(cleared.path, '/sessions?workspaceHash=bbb222');

    await click(buttonIn(row('alpha'), '移除'));
    await click([...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent.trim() === '确认'));
    const removed = view.calls().find(call => call.method === 'DELETE' && call.path.startsWith('/workspaces/'));
    assert.equal(removed.path, '/workspaces/aaa111');
    assert.equal(view.refreshes(), 2);
  } finally { await view.close(); }
});

test('expired-session cleanup applies the retention window to every workspace and reports partial failures', async () => {
  const view = await mount();
  try {
    const before = Date.now() - 30 * 86400000;
    await click([...document.querySelectorAll('button')].find(button => button.textContent.trim() === '清理过期会话'));
    const cleanups = view.calls().filter(call => call.method === 'DELETE' && call.path.startsWith('/sessions/cleanup?'));
    assert.equal(cleanups.length, 2);
    for (const call of cleanups) {
      const url = new URL(call.path, 'http://127.0.0.1:4567');
      assert.ok(['aaa111', 'bbb222'].includes(url.searchParams.get('workspaceHash')));
      assert.ok(Math.abs(Number(url.searchParams.get('before')) - before) < 5000);
    }
  } finally { await view.close(); }

  const failing = await mount();
  try {
    globalThis.__failPath = '/sessions/cleanup?';
    await click([...document.querySelectorAll('button')].find(button => button.textContent.trim() === '清理过期会话'));
    assert.match(document.querySelector('[role="alert"]').textContent, /1 个工作区清理失败/);
  } finally { await failing.close(); }
});
