import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// Legacy Chat.vue keeps three message-scroller affordances: auto-follow until
// the user scrolls away, a "back to bottom" button, a user-message thumbnail
// dock, and one-click folding of every open block. Assert the ported logic and
// the `loopra:collapse-all-blocks` bridge that the toolbar dispatches.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true };
// jsdom has no ResizeObserver; the message list only uses it for measurement.
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
globals.ResizeObserver = ResizeObserverStub;
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

const chatUrl = await sourceUrl('chat.ts');
const { CHAT_SCROLL_THRESHOLD, chatNearBottom, chatScrollState, truncatePreview, userMessageDock } = await import(chatUrl);

// Motion.tsx imports NextUI and framer-motion only for the provider helpers, so
// stub those two while keeping the real Disclosure/useCollapseAll code.
const motionUrl = await sourceUrl('components/Motion.tsx', {
  '@nextui-org/react': dataUrl(`const { createElement } = await import(${JSON.stringify(reactUrl)});
export const NextUIProvider = ({ children }) => createElement('div', null, children);`),
  'framer-motion': dataUrl('export const MotionGlobalConfig = {};'),
});
const { Disclosure } = await import(motionUrl);

const chatWindowUrl = await sourceUrl('chat-window.ts');
// Conversation.tsx must tag every message so the dock can jump to it.
const conversationUrl = await sourceUrl('components/Conversation.tsx', {
  './Motion': dataUrl(`const { createElement } = await import(${JSON.stringify(reactUrl)});
export const Collapse = ({ open, children }) => open ? createElement('div', null, children) : null;
export const Disclosure = ({ children }) => createElement('div', null, children);
export const Enter = ({ children, className, 'aria-label': label, 'data-message-id': id }) => createElement('article', { className, 'aria-label': label, 'data-message-id': id }, children);
export const useCollapseAll = () => {};`),
  'lucide-react': dataUrl('export default {};export const AlignLeft=()=>null;export const ChevronRight=()=>null;export const Copy=()=>null;export const GitBranch=()=>null;export const Pencil=()=>null;export const Undo2=()=>null;'),
  '../chat': chatUrl,
  '../chat-window': chatWindowUrl,
  '../file-stats': await sourceUrl('file-stats.ts'),
  '../lib': dataUrl('export const getSessionMessages = session => session.messages;'),
  './ui': dataUrl(`const { createElement } = await import(${JSON.stringify(reactUrl)});
export const IconButton = ({ label, children }) => createElement('button', { type: 'button', 'aria-label': label }, children);`),
  './BlockRenderer': dataUrl(`const { createElement } = await import(${JSON.stringify(reactUrl)});
export default ({ blocks }) => createElement('div', { className: 'blocks-stub' }, blocks.map((block, index) => createElement('p', { key: index }, block.content || block.type)));`),
  './ImagePreview': dataUrl(`const { createElement } = await import(${JSON.stringify(reactUrl)});
export const ImagePreviewProvider = ({ children }) => createElement('div', null, children);
export const useImagePreview = () => null;`),
  './Markdown': dataUrl('export const copyText = async () => true;'),
});
const { Messages } = await import(conversationUrl);

test('the scroll threshold matches the legacy 80px window', () => {
  assert.equal(CHAT_SCROLL_THRESHOLD, 80);
  const element = { scrollHeight: 1000, clientHeight: 400 };
  assert.equal(chatNearBottom({ ...element, scrollTop: 600 }), true, 'exactly at the bottom');
  assert.equal(chatNearBottom({ ...element, scrollTop: 521 }), true, '79px above the bottom');
  assert.equal(chatNearBottom({ ...element, scrollTop: 520 }), false, '80px above the bottom');
  assert.equal(chatNearBottom(null), true, 'an unmounted scroller counts as at bottom');
});

test('scrolling up marks the user away, returning near the bottom resumes follow', () => {
  const element = { scrollHeight: 1000, clientHeight: 400 };
  const away = chatScrollState({ ...element, scrollTop: 300 }, 400, false);
  assert.deepEqual(away, { away: true, showScrollButton: true });
  const returned = chatScrollState({ ...element, scrollTop: 595 }, 500, true);
  assert.deepEqual(returned, { away: false, showScrollButton: false });
  assert.deepEqual(chatScrollState(null, 0, false), { away: false, showScrollButton: false });
});

test('a programmatic smooth scroll downwards does not count as leaving', () => {
  const element = { scrollHeight: 1000, clientHeight: 400 };
  // Mid-animation: still far from the bottom but moving towards it.
  assert.deepEqual(chatScrollState({ ...element, scrollTop: 120 }, 60, false), { away: false, showScrollButton: true });
  // While already away, continued downward movement keeps the state.
  assert.deepEqual(chatScrollState({ ...element, scrollTop: 200 }, 120, true), { away: true, showScrollButton: true });
});

test('thumbnails truncate at 40 characters like the legacy dock', () => {
  assert.equal(truncatePreview(''), '');
  assert.equal(truncatePreview('短消息'), '短消息');
  assert.equal(truncatePreview('x'.repeat(40)), 'x'.repeat(40));
  assert.equal(truncatePreview('x'.repeat(41)), 'x'.repeat(40) + '…');
});

test('the dock lists user messages only and keeps their global index', () => {
  const dock = userMessageDock([
    { id: 'u1', role: 'user', text: '第一问' },
    { id: 'a1', role: 'assistant', text: '第一答' },
    { id: 'u2', role: 'user', text: '第二问' },
  ]);
  assert.deepEqual(dock.map(item => [item.id, item.globalIndex]), [['u1', 0], ['u2', 2]]);
  assert.deepEqual(userMessageDock([]), []);
});

test('one-click collapse folds disclosures through the window event', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Disclosure, { className: 'block', heading: '思考' }, createElement('p', null, '详细内容'))));
  assert.equal(container.querySelector('[data-open]').dataset.open, 'false');
  await act(async () => container.querySelector('button').click());
  assert.equal(container.querySelector('[data-open]').dataset.open, 'true');
  assert.equal(container.textContent.includes('详细内容'), true);
  await act(async () => { window.dispatchEvent(new dom.window.CustomEvent('loopra:collapse-all-blocks')); });
  assert.equal(container.querySelector('[data-open]').dataset.open, 'false');
  assert.equal(container.textContent.includes('详细内容'), false);
  await act(async () => root.unmount());
  container.remove();
});

test('the collapse-all hook detaches its listener on unmount', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Disclosure, { className: 'block', heading: '工具' }, createElement('p', null, '结果'))));
  await act(async () => container.querySelector('button').click());
  assert.equal(container.querySelector('[data-open]').dataset.open, 'true');
  await act(async () => root.unmount());
  assert.doesNotThrow(() => window.dispatchEvent(new dom.window.CustomEvent('loopra:collapse-all-blocks')));
  container.remove();
});

test('messages carry data-message-id so dock clicks can scroll to them', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const session = {
    id: 's', title: 't', workspace: 'w', kind: 'mock',
    messages: [
      { id: 'u1', role: 'user', text: '第一问' },
      { id: 'a1', role: 'assistant', text: '第一答' },
    ],
  };
  await act(async () => root.render(createElement(Messages, { session, loading: false, busy: false, notify: () => {}, onEdit: () => {}, onBranch: () => {}, onRollback: () => {} })));
  assert.deepEqual([...container.querySelectorAll('[data-message-id]')].map(node => node.dataset.messageId), ['u1', 'a1']);
  await act(async () => root.unmount());
  container.remove();
});

const renderMessages = async (messages, extra = {}) => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const session = { id: 's', title: 't', workspace: 'w', kind: 'mock', messages };
  await act(async () => root.render(createElement(Messages, { session, loading: false, busy: false, notify: () => {}, onEdit: () => {}, onBranch: () => {}, onRollback: () => {}, ...extra })));
  return { container, async close() { await act(async () => root.unmount()); container.remove(); } };
};
const longSession = () => Array.from({ length: 80 }, (_, index) => ({ id: `m${index}`, role: index % 2 ? 'assistant' : 'user', text: `消息 ${index}` }));

test('long sessions mount only the leading slice and reserve a bottom spacer', async () => {
  const view = await renderMessages(longSession());
  try {
    // With no viewport height the overscan band (1200px / 320px estimate) shows 4 rows.
    assert.equal(view.container.querySelectorAll('.virtual-message-item').length, 4);
    assert.deepEqual([...view.container.querySelectorAll('[data-message-id]')].map(node => node.dataset.messageId), ['m0', 'm1', 'm2', 'm3']);
    const spacers = [...view.container.querySelectorAll('.virtual-spacer')];
    assert.equal(spacers.length, 1, 'top spacer collapses to zero at the top of the list');
    assert.equal(spacers[0].style.height, `${(80 - 4) * 320}px`);
  } finally { await view.close(); }
});

test('short sessions still render every message without spacers', async () => {
  const view = await renderMessages([{ id: 'u1', role: 'user', text: '问' }, { id: 'a1', role: 'assistant', text: '答' }]);
  try {
    assert.equal(view.container.querySelectorAll('.virtual-spacer').length, 0);
    assert.equal(view.container.querySelectorAll('.virtual-message-item').length, 0);
    assert.deepEqual([...view.container.querySelectorAll('[data-message-id]')].map(node => node.dataset.messageId), ['u1', 'a1']);
  } finally { await view.close(); }
});

test('the message list publishes its offsets for unmounted jumps', async () => {
  const offsetsRef = { current: [] };
  const view = await renderMessages(longSession(), { offsetsRef });
  try {
    assert.equal(offsetsRef.current.length, 81);
    assert.equal(offsetsRef.current[0], 0);
    assert.equal(offsetsRef.current[1], 320);
  } finally { await view.close(); }
});

// Legacy ChatMessage.vue exposed a per-message 查看原始记录 shortcut on the
// compacted-history summary; it reopens the session's raw-event log.
test('the compacted summary links to the raw events log', async () => {
  const compacted = [{ id: 'u1', role: 'user', text: '[历史上下文折叠] 说明\n<compacted-summary>早前的上下文</compacted-summary>' }];
  let opened = 0;
  const view = await renderMessages(compacted, { onRawEvents: () => { opened += 1; } });
  try {
    const button = view.container.querySelector('.compacted-raw-btn');
    assert.ok(button, 'the raw-events button renders');
    assert.equal(button.textContent, '查看原始记录');
    await act(async () => button.click());
    assert.equal(opened, 1);
  } finally { await view.close(); }
  // Without the handler the affordance is hidden.
  const plain = await renderMessages(compacted);
  try { assert.equal(plain.container.querySelector('.compacted-raw-btn'), null); } finally { await plain.close(); }
});
