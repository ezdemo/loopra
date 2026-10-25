import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const globals = {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
};
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => {
  dom.window.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const transpile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const reactUrl = import.meta.resolve('react');
const motionUrl = dataUrl(`
  import { createElement } from ${JSON.stringify(reactUrl)};
  export const Enter = ({ as = 'div', children, ...props }) => createElement(as, props, children);
  export const Collapse = ({ open, children }) => open ? children : null;
  export const Disclosure = ({ children }) => children;
  export const useCollapseAll = () => {};
`);
const blockUrl = dataUrl(`
  import { createElement } from ${JSON.stringify(reactUrl)};
  export const renders = [];
  export default function BlockRenderer({ blocks, onOpenFile, onDiff }) {
    renders.push(blocks);
    return createElement('div', null,
      blocks.map(block => createElement('p', { key: block.id }, block.content)),
      onOpenFile && createElement('button', { className: 'open-file', onClick: () => onOpenFile('example.ts') }, 'open'),
      onDiff && createElement('button', { className: 'open-diff', onClick: () => onDiff('example.ts', 'patch') }, 'diff'));
  }
`);
const { renders } = await import(blockUrl);
const specifiers = {
  react: reactUrl,
  'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'),
  'lucide-react': import.meta.resolve('lucide-react'),
  '../chat': dataUrl(transpile(await readFile(new URL('../src/chat.ts', import.meta.url), 'utf8'))),
  '../chat-window': dataUrl(transpile(await readFile(new URL('../src/chat-window.ts', import.meta.url), 'utf8'))),
  '../file-stats': dataUrl(transpile(await readFile(new URL('../src/file-stats.ts', import.meta.url), 'utf8'))),
  '../lib': dataUrl('export const getSessionMessages = session => session.messages;'),
  './Motion': motionUrl,
  './BlockRenderer': blockUrl,
  './Markdown': dataUrl('export const copyText = async () => {};'),
  './ui': dataUrl(`import { createElement } from ${JSON.stringify(reactUrl)}; export const IconButton = ({ label, ...props }) => createElement('button', { ...props, 'aria-label': label });`),
  './ImagePreview': dataUrl('export const ImagePreviewProvider = ({ children }) => children; export const useImagePreview = () => null;'),
};
let output = transpile(await readFile(new URL('../src/components/Conversation.tsx', import.meta.url), 'utf8'));
for (const [specifier, url] of Object.entries(specifiers)) {
  output = output.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
}
const { Messages } = await import(dataUrl(output));
const message = id => ({ id, role: 'assistant', text: `Answer ${id}`, blocks: [{ id: `${id}-text`, type: 'content', content: `Answer ${id}` }] });
const actions = () => ({ busy: false, notify() {}, onEdit() {}, onBranch() {}, onRollback() {} });

async function mount(session, props = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const render = async (nextSession, nextProps = {}) => {
    await act(async () => root.render(createElement(Messages, { session: nextSession, loading: false, ...actions(), ...nextProps })));
  };
  await render(session, props);
  return { container, render, async close() { await act(async () => root.unmount()); container.remove(); } };
}

test('draft/metadata updates skip historical bodies and stream updates render only the changed message', async () => {
  const session = { id: 'session', kind: 'remote', messages: Array.from({ length: 12 }, (_, index) => message(String(index))) };
  const view = await mount(session);
  try {
    renders.length = 0;
    await view.render({ ...session, title: 'renamed' });
    assert.equal(renders.length, 0);
    const messages = session.messages.map((entry, index) => index === 11 ? { ...entry, text: 'updated', blocks: [{ id: '11-text', type: 'content', content: 'updated' }] } : entry);
    await view.render({ ...session, messages });
    assert.equal(renders.length, 1);
    assert.equal(renders[0][0].content, 'updated');
  } finally { await view.close(); }
});

test('cached bodies invoke the latest callbacks and optional controls follow availability', async () => {
  const session = { id: 'session', kind: 'remote', messages: [message('answer')] };
  const calls = [];
  const view = await mount(session, { onOpenFile: () => calls.push('old') });
  try {
    renders.length = 0;
    await view.render(session, { onOpenFile: path => calls.push(`new:${path}`) });
    assert.equal(renders.length, 0);
    await act(async () => view.container.querySelector('.open-file').click());
    assert.deepEqual(calls, ['new:example.ts']);
    await view.render(session, { onDiff: (path, diff) => calls.push(`${path}:${diff}`) });
    assert.equal(view.container.querySelector('.open-file'), null);
    await act(async () => view.container.querySelector('.open-diff').click());
    assert.deepEqual(calls, ['new:example.ts', 'example.ts:patch']);
  } finally { await view.close(); }
});

for (const agentId of ['pi', 'dsh']) {
  test(`${agentId} does not offer historical branching without adapter support`, async () => {
    const view = await mount({ id: `${agentId}-session`, kind: 'remote', agentId, messages: [message('answer')] });
    try {
      assert.equal(view.container.querySelector('button[aria-label="继续到新会话"]'), null);
      assert.ok(view.container.querySelector('button[aria-label="复制回复"]'));
    } finally { await view.close(); }
  });
}

test('a running duration ticks without rendering the message body again', async () => {
  const session = { id: 'session', kind: 'remote', messages: [{ ...message('live'), startedAt: Date.now() - 1000 }] };
  const view = await mount(session, { loading: true });
  try {
    const before = view.container.querySelector('.assistant-process-toggle').textContent;
    renders.length = 0;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
    assert.notEqual(view.container.querySelector('.assistant-process-toggle').textContent, before);
    assert.equal(renders.length, 0);
  } finally { await view.close(); }
});

test('replayed turns omit elapsed time and completed turns keep their recorded duration', async () => {
  const startedAt = Date.now() - 10000;
  const blocks = [
    { id: 'reason', type: 'reasoning', content: 'thinking' },
    { id: 'answer', type: 'content', content: 'done' },
  ];
  const session = { id: 'session', kind: 'remote', messages: [{ ...message('answer'), blocks, startedAt, finishedAt: startedAt + 5000 }] };
  const view = await mount(session, { showDuration: false });
  try {
    assert.equal(view.container.querySelector('.assistant-process-toggle').textContent, '思考过程');
    await view.render(session);
    assert.equal(view.container.querySelector('.assistant-process-toggle').textContent, '用时 5秒');
  } finally { await view.close(); }
});
