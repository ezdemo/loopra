import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const dom = new JSDOM('<html><body></body></html>', { url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, navigator: dom.window.navigator,
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const source = await readFile(new URL('../src/components/PluginFrame.tsx', import.meta.url), 'utf8');
let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
for (const [name, url] of Object.entries({ react: import.meta.resolve('react'), 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'),
  './RemoteControls': dataUrl('export const errorText = error => error.message;') })) {
  outputText = outputText.replaceAll(`'${name}'`, JSON.stringify(url)).replaceAll(`"${name}"`, JSON.stringify(url));
}
const { PluginFrame } = await import(dataUrl(outputText));

async function mount(handler, context = { workspaceHash: 'one', sessionId: 'one/session' }) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container), requests = [];
  const api = {
    request: async (path, method, value, signal) => { requests.push({ path, method, value, signal }); return path.endsWith('/open') ? { page: '/plugins/example/ui/t/ticket/' } : handler?.(value); },
    assetUrl: path => `http://test.invalid${path}`,
    pluginPage: () => '', pluginSidebar: () => '', pluginMenu: () => '',
  };
  const render = next => act(async () => root.render(createElement(PluginFrame, { api, id: 'example', name: 'Example', slot: 'ui', context: next })));
  await render(context);
  const message = (data, source = container.querySelector('iframe')?.contentWindow) => act(async () => window.dispatchEvent(new window.MessageEvent('message', { source, data: { type: 'loopra', ...data } })));
  return { container, requests, render, message, close: () => act(async () => { root.unmount(); container.remove(); }) };
}

test('plugin requests use its own route and current workbench context', async () => {
  const view = await mount(() => ({ items: ['hello'] }));
  try {
    const frame = view.container.querySelector('iframe'), replies = [];
    frame.contentWindow.postMessage = data => replies.push(data);
    await view.message({ op: 'hello' });
    assert.equal(replies.at(-1).context.workspaceHash, 'one');
    await view.render({ workspaceHash: 'two', sessionId: 'two/session', filePath: 'src/main.ts' });
    assert.equal(view.container.querySelector('iframe'), frame, 'context changes must preserve the page');
    assert.equal(replies.at(-1).context.workspaceHash, 'two');
    await view.message({ op: 'service:request', id: '1', action: 'list', value: { plugin: 'other' }, context: { workspaceHash: 'forged' } });
    const request = view.requests.find(item => item.path.endsWith('/request'));
    assert.equal(request.path, '/plugins/example/request');
    assert.equal(request.value.context.workspaceHash, 'two');
    assert.deepEqual(replies.at(-1).value, { items: ['hello'] });
    const count = view.requests.length;
    await view.message({ op: 'service:request', action: 'list' }, window);
    assert.equal(view.requests.length, count, 'another frame must not access the bridge');
  } finally { await view.close(); }
});

test('a broken plugin page can be retried without retaining its old requests', async () => {
  const view = await mount();
  try {
    const oldFrame = view.container.querySelector('iframe');
    await view.message({ op: 'hello' });
    await view.message({ op: 'error', message: 'Page failed' });
    assert.match(view.container.querySelector('[role="alert"]').textContent, /Page failed/);
    assert.equal(view.container.querySelector('iframe'), null);
    await act(async () => view.container.querySelector('button').click());
    assert.notEqual(view.container.querySelector('iframe'), oldFrame);
    assert.equal(view.requests.filter(item => item.path.endsWith('/open')).length, 2);
    assert.equal(view.requests[0].signal.aborted, true);
    await view.message({ op: 'hello' });
    assert.equal(view.container.querySelector('[role="alert"]'), null);
  } finally { await view.close(); }
});

test('a backend error is returned to its caller without breaking the page', async () => {
  const view = await mount(() => { throw new Error('Unknown operation'); });
  try {
    const replies = [];
    view.container.querySelector('iframe').contentWindow.postMessage = data => replies.push(data);
    await view.message({ op: 'hello' });
    await view.message({ op: 'service:request', id: 'error', action: 'unknown' });
    assert.equal(replies.at(-1).error, 'Unknown operation');
    assert.equal(view.container.querySelector('[role="alert"]'), null);
  } finally { await view.close(); }
});

test('the page bridge updates context and reports script and promise failures', async () => {
  const bridge = await readFile(new URL('../../internal/service/plugin/bridge.js', import.meta.url), 'utf8');
  const page = new JSDOM('<html><body></body></html>', { runScripts: 'outside-only' });
  const messages = [], changes = [], { window } = page;
  window.postMessage = value => messages.push(value);
  try {
    window.eval(bridge);
    assert.equal(messages[0].op, 'hello');
    window.loopra.onContext(context => changes.push(context.workspaceHash));
    const ready = workspaceHash => window.dispatchEvent(new window.MessageEvent('message', { source: window, data: { type: 'loopra', op: 'ready', theme: { dark: true }, context: { workspaceHash } } }));
    ready('one');
    await window.loopra.ready;
    ready('two');
    assert.deepEqual(changes, ['one', 'two']);
    assert.equal(window.loopra.context.workspaceHash, 'two');
    assert.equal(window.document.documentElement.dataset.theme, 'dark');
    window.dispatchEvent(new window.ErrorEvent('error', { message: 'Broken script' }));
    assert.equal(messages.at(-1).message, 'Broken script');
    const rejection = new window.Event('unhandledrejection');
    rejection.reason = new Error('Rejected task');
    window.dispatchEvent(rejection);
    assert.equal(messages.at(-1).message, 'Rejected task');
  } finally { page.window.close(); }
});
