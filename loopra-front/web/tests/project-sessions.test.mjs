import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// The project maintenance dialog deletes server data, so assert the exact
// endpoints instead of exercising a live backend.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const reactUrl = import.meta.resolve('react');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const nextuiStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const Button = ({ children, onPress, isDisabled, isLoading, ...rest }) => createElement('button', { type: 'button', disabled: !!isDisabled || !!isLoading, onClick: onPress, ...rest }, children);
export const Modal = ({ children }) => createElement('div', { role: 'dialog' }, children);
export const ModalContent = ({ children }) => createElement('div', null, children);
`);

const source = await readFile(new URL('../src/components/ProjectSessions.tsx', import.meta.url), 'utf8');
let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
for (const [specifier, url] of Object.entries({ react: reactUrl, 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), '@nextui-org/react': nextuiStub })) {
  outputText = outputText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
}
const { default: ProjectSessions } = await import(dataUrl(outputText));

const workspace = { hash: 'aaa111', name: 'alpha', path: 'C:\\alpha' };

async function mount(count = 3) {
  globalThis.__calls = [];
  const api = { request: (path, method = 'GET', body) => { globalThis.__calls.push({ path, method, body }); return Promise.resolve('ok'); } };
  const events = [];
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(ProjectSessions, {
    api, workspace, count,
    onClose: () => events.push('close'),
    onRefresh: async () => { events.push('refresh'); },
    onCompleted: kind => events.push(`completed:${kind}`),
    notify: message => events.push(`notify:${message}`),
  })));
  return { container, root, calls: () => globalThis.__calls, events, async close() { await act(async () => root.unmount()); container.remove(); } };
}
const buttonIn = (element, text) => [...element.querySelectorAll('button')].find(candidate => candidate.textContent.trim() === text);
async function click(element) { await act(async () => { element.click(); await Promise.resolve(); await Promise.resolve(); }); }

test('project dialog shows the session count and refresh only reloads', async () => {
  const view = await mount(4);
  assert.match(view.container.textContent, /4 个会话/);
  await click(buttonIn(view.container, '刷新会话列表'));
  assert.deepEqual(view.calls(), []);
  assert.deepEqual(view.events, ['refresh', 'completed:refresh', 'notify:会话列表已刷新', 'close']);
  await view.close();
});

test('clearing hits the scoped session endpoint and reports completion', async () => {
  const view = await mount();
  await click(buttonIn(view.container, '清空会话列表'));
  assert.deepEqual(view.calls(), [{ path: '/sessions?workspaceHash=aaa111', method: 'DELETE', body: undefined }]);
  assert.deepEqual(view.events, ['refresh', 'completed:clear', 'notify:会话已清空', 'close']);
  await view.close();
});

test('deleting drops the project record from Loopra', async () => {
  const view = await mount();
  await click(buttonIn(view.container, '删除项目'));
  assert.deepEqual(view.calls(), [{ path: '/workspaces/aaa111', method: 'DELETE', body: undefined }]);
  assert.deepEqual(view.events, ['refresh', 'completed:delete', 'notify:项目已删除', 'close']);
  await view.close();
});
