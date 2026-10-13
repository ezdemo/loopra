import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// The sub-agent panel reads stored runs and can continue an active one; assert
// the endpoints, the replay rebuild and the SSE import end to end with stubs.
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
const iconsStub = dataUrl('export const ChevronRight=()=>null;export const RefreshCw=()=>null;export const Trash2=()=>null;');
const uiStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const IconButton = ({ label, children, onClick }) => createElement('button', { type: 'button', 'aria-label': label, onClick }, children);
`);
const controlsStub = dataUrl(`
const React = await import(${JSON.stringify(reactUrl)});
export const errorText = cause => cause instanceof Error ? cause.message : String(cause);
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
export const RemoteState = ({ loading, error }) => error ? React.createElement('p', { role: 'alert' }, error) : null;
export function ConfirmAction({ title, children, action, onClose, onDone }) {
  return React.createElement('div', { role: 'alertdialog', 'aria-label': title }, children,
    React.createElement('button', { type: 'button', onClick: async () => { await action(); onDone?.(); onClose(); } }, '确认'));
}
`);
const blocksStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export default ({ blocks }) => createElement('div', { className: 'blocks' }, blocks.map(block =>
  createElement('p', { key: block.id, 'data-type': block.type }, block.type + ':' + (block.content || block.name || ''))));
`);
const subSessionsUrl = await sourceUrl('sub-sessions.ts');
const Panel = (await import(await sourceUrl('components/SubAgentsPanel.tsx', {
  '@nextui-org/react': nextuiStub,
  'lucide-react': iconsStub,
  './ui': uiStub,
  './RemoteControls': controlsStub,
  './BlockRenderer': blocksStub,
  '../sub-sessions': subSessionsUrl,
}))).default;

const list = [
  { subSessionId: 'sub-a', name: '小瓜', title: '修复登录', status: 'completed', startedAt: Date.UTC(2026, 0, 2, 3, 4), endedAt: Date.UTC(2026, 0, 2, 3, 9), eventCount: 4 },
  { subSessionId: 'sub-b', task: '写测试', status: 'running', startedAt: Date.UTC(2026, 0, 3, 3, 4), endedAt: 0, eventCount: 2 },
];
const events = [
  { type: 'sub_start', task: '修复登录' },
  { type: 'sub_content', content: '已修复' },
  { type: 'sub_tool_call', name: 'read', args: {} },
  { type: 'sub_tool_result', name: 'read', result: 'ok' },
  { type: 'sub_end', status: 'completed' },
];

async function mount() {
  globalThis.__calls = []; globalThis.__notify = [];
  const api = {
    assetUrl: path => `http://test.invalid/api${path}`,
    request: (path, method = 'GET') => {
      globalThis.__calls.push({ path, method });
      if (path.startsWith('/sub-sessions?')) return Promise.resolve(list);
      if (path.includes('/events')) return Promise.resolve(events);
      return Promise.resolve({ deleted: true });
    },
  };
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Panel, {
    api, workspaceHash: 'hash1', sessionName: 'parent', notify: message => globalThis.__notify.push(message),
    onDiff: path => globalThis.__notify.push(`diff:${path}`),
  })));
  return { container, root, async close() { await act(async () => root.unmount()); container.remove(); } };
}
const buttonIn = (element, text) => [...element.querySelectorAll('button')].find(candidate => candidate.textContent.includes(text));
async function click(element) { await act(async () => { element.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); }
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

test('lists the parent session sub-agent runs with status and time', async () => {
  const view = await mount();
  try {
    const text = view.container.textContent;
    assert.match(text, /小瓜：修复登录/);
    assert.match(text, /已完成/);
    assert.match(text, /写测试/);
    assert.match(text, /运行中/);
    assert.deepEqual(globalThis.__calls[0], { path: '/sub-sessions?workspaceHash=hash1&sessionName=parent', method: 'GET' });
  } finally { await view.close(); }
});

test('clicking a run replays its stored events as blocks', async () => {
  const view = await mount();
  try {
    await click(buttonIn(view.container, '小瓜：修复登录'));
    await flush(); await flush();
    assert.ok(globalThis.__calls.some(call => call.path === '/sub-sessions/sub-a/events?workspaceHash=hash1&sessionName=parent'));
    const rendered = [...view.container.querySelectorAll('.blocks p')].map(node => node.getAttribute('data-type') + ':' + node.textContent);
    assert.deepEqual(rendered, ['content:content:已修复', 'tool_call:tool_call:read']);
  } finally { await view.close(); }
});

test('deleting a run confirms and hits the scoped endpoint', async () => {
  const view = await mount();
  try {
    await click(view.container.querySelector('button[aria-label="删除 小瓜：修复登录"]'));
    await click(buttonIn(view.container.querySelector('[role="alertdialog"]'), '确认'));
    assert.ok(globalThis.__calls.some(call => call.method === 'DELETE' && call.path === '/sub-sessions/sub-a?workspaceHash=hash1&sessionName=parent'));
    assert.deepEqual(globalThis.__notify, ['子代理会话已删除']);
  } finally { await view.close(); }
});

test('continuing a run streams sub_* events into the replay', async () => {
  const view = await mount();
  const originalFetch = globalThis.fetch;
  try {
    await click(buttonIn(view.container, '写测试'));
    await flush(); await flush();
    const input = view.container.querySelector('input[aria-label="继续子代理对话"]');
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    await act(async () => { setValue.call(input, '请继续'); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    const frames = [
      'data: {"type":"sub_content","content":"好的"}\n\n',
      'event: sub_end\ndata: {"status":"completed"}\n\n',
    ];
    globalThis.fetch = async (url, options) => {
      globalThis.__calls.push({ path: String(url), method: options?.method, body: options?.body });
      return { ok: true, body: new ReadableStream({ start(controller) { const encoder = new TextEncoder(); for (const frame of frames) controller.enqueue(encoder.encode(frame)); controller.close(); } }) };
    };
    await click(buttonIn(view.container, '发送'));
    // The SSE reader resolves over several microtask turns; give it a real tick.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    const sent = globalThis.__calls.find(call => call.method === 'POST');
    assert.equal(sent.path, 'http://test.invalid/api/sub-sessions/sub-b/chat?workspaceHash=hash1&sessionName=parent');
    assert.deepEqual(JSON.parse(sent.body), { message: '请继续' });
    const text = view.container.textContent;
    assert.match(text, /\*\*你：\*\* 请继续/);
    assert.match(text, /好的/);
  } finally {
    globalThis.fetch = originalFetch;
    // Always unmount: the panel polls its list on a timer.
    await view.close();
  }
});
