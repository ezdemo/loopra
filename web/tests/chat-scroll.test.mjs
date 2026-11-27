import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { reactI18nextStubUrl } from './i18n-test-utils.mjs';

// Legacy Chat.vue keeps three message-scroller affordances: auto-follow until
// the user scrolls away, a "back to bottom" button, a user-message thumbnail
// dock, and one-click folding of every open block. Assert the ported logic and
// the `loopra:collapse-all-blocks` bridge that the toolbar dispatches.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true };
// jsdom has no ResizeObserver; the message list only uses it for measurement.
class ResizeObserverStub {
  static instances = [];
  constructor(callback) { this.callback = callback; this.observed = new Set(); ResizeObserverStub.instances.push(this); }
  observe(element) { this.element = element; this.observed.add(element); }
  unobserve() {}
  disconnect() { this.disconnected = true; }
}
globals.ResizeObserver = ResizeObserverStub;
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => { delete globalThis.__loopraTestImagePreviews; dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const reactUrl = import.meta.resolve('react');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
async function sourceUrl(name, dependencies = {}) {
  const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
  for (const [specifier, url] of Object.entries({ react: reactUrl, 'react-i18next': reactI18nextStubUrl, 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), ...dependencies })) {
    outputText = outputText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
  }
  return dataUrl(outputText);
}

const chatUrl = await sourceUrl('chat.ts');
const { CHAT_SCROLL_THRESHOLD, chatNearBottom, chatScrollState, chatShouldFollowMessages, pinChatScroller, truncatePreview, userMessageDock } = await import(chatUrl);

// Motion.tsx imports NextUI and framer-motion only for the provider helpers, so
// stub those two while keeping the real Disclosure/useCollapseAll code.
const motionUrl = await sourceUrl('components/Motion.tsx', {
  '@nextui-org/react': dataUrl(`const { createElement } = await import(${JSON.stringify(reactUrl)});
export const NextUIProvider = ({ children }) => createElement('div', null, children);`),
  'framer-motion': dataUrl('export const MotionGlobalConfig = {};'),
});
const { Disclosure } = await import(motionUrl);

const { default: BlockRenderer } = await import(await sourceUrl('components/BlockRenderer.tsx', {
  './Motion': motionUrl,
  '../chat': chatUrl,
  '../backend': dataUrl(`export const USER_STOPPED_REPLY = '{{用户主动打断}}';`),
  '../tool-params': await sourceUrl('tool-params.ts'),
  'lucide-react': import.meta.resolve('lucide-react'),
  '@nextui-org/react': dataUrl('export const Button = () => null;'),
  './ui': dataUrl('export const IconButton = () => null;'),
  './Markdown': dataUrl('export default () => null;'),
  './UnifiedDiff': dataUrl('export default () => null;'),
  './ToolImageResult': dataUrl('export default () => null;'),
  './FileGlyph': await sourceUrl('components/FileGlyph.tsx', {
    'lucide-react': import.meta.resolve('lucide-react'),
    '../file-icons': await sourceUrl('file-icons.ts'),
  }),
}));

const chatWindowUrl = await sourceUrl('chat-window.ts', { './chat': chatUrl });
const { estimateMessageHeight, virtualMessageWindow } = await import(chatWindowUrl);
// Conversation.tsx must tag every message so the dock can jump to it.
const imagePreviews = [];
globalThis.__loopraTestImagePreviews = imagePreviews;
const messageContextUrl = await sourceUrl('components/MessageContext.tsx', {
  '../message-context': await sourceUrl('message-context.ts'),
  './ImagePreview': dataUrl('export const useImagePreview = () => src => globalThis.__loopraTestImagePreviews.push(src);'),
  'lucide-react': import.meta.resolve('lucide-react'),
  './FileGlyph': dataUrl('export default () => null;'),
  '@nextui-org/react': dataUrl(`const { createElement } = await import(${JSON.stringify(reactUrl)});
export const Button = ({ onPress, children, ...props }) => createElement('button', { className: props.className, 'aria-label': props['aria-label'], 'aria-haspopup': props['aria-haspopup'], onClick: onPress }, children);
export const Modal = ({ isOpen, children, onClose }) => isOpen ? createElement('div', { role: 'dialog' }, children, createElement('button', { 'aria-label': '关闭', onClick: onClose }, '关闭')) : null;
export const ModalContent = ({ children }) => createElement('div', null, children);
export const ModalHeader = ({ children }) => createElement('header', null, children);
export const ModalBody = ({ children, className }) => createElement('div', { className }, children);`),
});
const conversationUrl = await sourceUrl('components/Conversation.tsx', {
  './MessageContext': messageContextUrl,
  './WebSources': dataUrl('export default () => null;'),
  './Motion': dataUrl(`const { createElement } = await import(${JSON.stringify(reactUrl)});
export const Collapse = ({ open, children }) => open ? createElement('div', null, children) : null;
export { Disclosure } from ${JSON.stringify(motionUrl)};
export const Enter = ({ children, className, 'aria-label': label, 'data-message-id': id }) => createElement('article', { className, 'aria-label': label, 'data-message-id': id }, children);
export const useCollapseAll = () => {};`),
  'lucide-react': dataUrl('export default {};export const AlignLeft=()=>null;export const ChevronRight=()=>null;export const Copy=()=>null;export const GitBranch=()=>null;export const Paperclip=()=>null;export const Pencil=()=>null;export const Undo2=()=>null;'),
  '../chat': chatUrl,
  '../chat-window': chatWindowUrl,
  '../file-stats': await sourceUrl('file-stats.ts'),
  '../web-sources': await sourceUrl('web-sources.ts'),
  '../lib': dataUrl('export const getSessionMessages = session => session.messages;'),
  './ui': dataUrl(`const { createElement } = await import(${JSON.stringify(reactUrl)});
export const IconButton = ({ label, children, onClick }) => createElement('button', { type: 'button', 'aria-label': label, onClick }, children);`),
  './BlockRenderer': dataUrl(`const { createElement } = await import(${JSON.stringify(reactUrl)});
export default ({ blocks }) => createElement('div', { className: 'blocks-stub' }, blocks.map((block, index) => createElement('p', { key: index }, block.content || block.type)));`),
  './ImagePreview': dataUrl(`const { createElement } = await import(${JSON.stringify(reactUrl)});
export const ImagePreviewProvider = ({ children }) => createElement('div', null, children);
export const useImagePreview = () => null;`),
  './Markdown': dataUrl('export const copyText = async () => true;'),
  './PixelLoader': dataUrl('export default () => null;'),
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

test('an upward clamp exactly at the bottom does not count as leaving', () => {
  const element = { scrollHeight: 900, clientHeight: 400 };
  assert.deepEqual(chatScrollState({ ...element, scrollTop: 500 }, 600, false), { away: false, showScrollButton: false });
});

test('a deliberate small upward scroll near the bottom counts as leaving', () => {
  const element = { scrollHeight: 900, clientHeight: 400 };
  assert.deepEqual(chatScrollState({ ...element, scrollTop: 495 }, 500, false), { away: true, showScrollButton: false });
});

test('message updates follow only after the reader returns near the bottom', () => {
  const element = { scrollHeight: 900, clientHeight: 400 };
  const upward = chatScrollState({ ...element, scrollTop: 495 }, 500, false);
  assert.equal(upward.away, true, 'a deliberate small upward scroll leaves the bottom even inside the 80px threshold');
  assert.equal(chatShouldFollowMessages(upward.away), false, 'streaming updates must not pull that reader back down');
  const returned = chatScrollState({ ...element, scrollTop: 498 }, 495, upward.away);
  assert.equal(returned.away, false, 'scrolling back inside the threshold resumes follow');
  assert.equal(chatShouldFollowMessages(returned.away), true);
});

test('smooth wheel increments inside the threshold still leave and stay away', () => {
  const element = { scrollHeight: 900, clientHeight: 400 };
  let away = false;
  let previousTop = 500;
  for (const scrollTop of [499.5, 499, 498.5]) {
    const next = chatScrollState({ ...element, scrollTop }, previousTop, away, true);
    away = next.away;
    previousTop = scrollTop;
  }
  assert.equal(away, true, 'small smooth wheel steps accumulate into a deliberate upward scroll');
  assert.equal(chatScrollState({ ...element, scrollTop: 498.5 }, previousTop, away).away, true, 'staying inside the threshold does not by itself resume follow');
  const returned = chatScrollState({ ...element, scrollTop: 499 }, previousTop, away);
  assert.equal(returned.away, false, 'a downward step back near the bottom resumes follow');
});

test('an upward clamp back to the bottom re-enables follow when it was not user input', () => {
  const element = { scrollHeight: 900, clientHeight: 400 };
  assert.equal(chatScrollState({ ...element, scrollTop: 499 }, 520, true).away, false, 'collapse-induced clamping can resume follow because the reader is again at the bottom');
  assert.equal(chatScrollState({ ...element, scrollTop: 499 }, 500, true, true).away, true, 'the same position does not resume after deliberate upward wheel input');
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
const longSession = () => Array.from({ length: 80 }, (_, index) => {
  const role = index % 2 ? 'assistant' : 'user';
  // Ten user lines and eight assistant lines both estimate as the legacy 320px row.
  const lines = role === 'user' ? 10 : 8;
  return { id: `m${index}`, role, text: Array.from({ length: lines }, (_, line) => `消息 ${index}.${line}`).join('\n') };
});

test('external agents offer historical branches without enabling unsupported edit or rollback actions', async () => {
  const messages = [
    { id: 'u1', role: 'user', text: '问', rollbackId: 'rollback', rollbackTimestamp: 123, snapshotId: 'snapshot' },
    { id: 'a1', role: 'assistant', text: '答', historyCount: 2 },
  ];
  for (const agentId of ['codex', 'claude-code', 'soloncode', 'custom-acp']) {
    const calls = [];
    const view = await renderMessages(messages, {
      session: { id: 's', title: 't', workspace: 'w', kind: 'mock', agentId, messages },
      onBranch: id => calls.push(id),
    });
    try {
      const labels = ['复制消息', '复制回复'];
      if (agentId !== 'custom-acp') labels.push('继续到新会话');
      assert.deepEqual([...view.container.querySelectorAll('.msg-actions button')].map(button => button.getAttribute('aria-label')), labels, agentId);
      const branch = view.container.querySelector('[aria-label="继续到新会话"]');
      if (branch) {
        await act(async () => branch.click());
        assert.deepEqual(calls, ['a1']);
      }
    } finally { await view.close(); }
  }
});

test('native and legacy sessions retain working edit, rollback and branch actions', async () => {
  const messages = [
    { id: 'u1', role: 'user', text: '问', rollbackId: 'rollback' },
    { id: 'a1', role: 'assistant', text: '答', historyCount: 2 },
  ];
  for (const agentId of ['native', undefined]) {
    const calls = [];
    const view = await renderMessages(messages, {
      session: { id: 's', title: 't', workspace: 'w', kind: 'mock', agentId, messages },
      onEdit: text => calls.push(['edit', text]),
      onRollback: message => calls.push(['rollback', message.id]),
      onBranch: id => calls.push(['branch', id]),
    });
    try {
      for (const label of ['重新编辑消息', '撤回到此消息', '继续到新会话']) {
        const button = view.container.querySelector(`[aria-label="${label}"]`);
        assert.ok(button, label);
        await act(async () => button.click());
      }
      assert.deepEqual(calls, [['edit', '问'], ['rollback', 'u1'], ['branch', 'a1']]);
      assert.ok(view.container.querySelector('[aria-label="复制消息"]'));
      assert.ok(view.container.querySelector('[aria-label="复制回复"]'));
    } finally { await view.close(); }
  }
});

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


function patchVirtualLayout(container, positions) {
  for (const node of container.querySelectorAll('.virtual-message-item')) {
    const id = node.querySelector('[data-message-id]')?.dataset.messageId;
    const position = positions.get(id) || { top: 0, height: 320 };
    node.getBoundingClientRect = () => ({ top: position.top, height: position.height, bottom: position.top + position.height, left: 0, right: 600, width: 600, x: 0, y: position.top, toJSON: () => ({}) });
  }
}
async function measureVirtualMessages(afterCallback) {
  const resize = ResizeObserverStub.instances.at(-1);
  const entries = [...resize.observed].map(target => ({ target }));
  const original = resize.callback;
  if (afterCallback) resize.callback = callbackEntries => { original(callbackEntries); afterCallback(); };
  try { await act(async () => resize.callback(entries)); }
  finally { resize.callback = original; }
}

test('sparse measured outliers do not inflate unmounted row estimates', async () => {
  const scroll = document.createElement('div');
  Object.defineProperties(scroll, {
    scrollTop: { configurable: true, writable: true, value: 0 },
    clientHeight: { configurable: true, value: 600 },
  });
  scroll.getBoundingClientRect = () => ({ top: 0, height: 600, bottom: 600, left: 0, right: 800, width: 800, x: 0, y: 0, toJSON: () => ({}) });
  const scrollRef = { current: scroll };
  const layouts = [];
  const view = await renderMessages(longSession(), { scrollRef, onLayout: () => layouts.push(1) });
  try {
    const rows = [...view.container.querySelectorAll('.virtual-message-item')];
    for (const node of rows) {
      const id = node.querySelector('[data-message-id]').dataset.messageId;
      const index = Number(id.slice(1));
      node.getBoundingClientRect = () => ({ top: 0, height: index % 2 ? 1000 : 80, bottom: index % 2 ? 1000 : 80, left: 0, right: 600, width: 600, x: 0, y: 0, toJSON: () => ({}) });
    }
    const layoutCount = layouts.length;
    assert.ok(layoutCount > 0, 'initial message layout is published');
    await measureVirtualMessages();
    assert.ok(layouts.length > layoutCount, 'measurement changes are published');
    const beforeScroll = layouts.length;
    scroll.scrollTop = 50;
    await act(async () => scroll.dispatchEvent(new dom.window.Event('scroll')));
    assert.equal(layouts.length, beforeScroll, 'viewport-only scrolling does not repin the reader');
    const spacers = [...view.container.querySelectorAll('.virtual-spacer')];
    const bottom = spacers.at(-1);
    assert.ok(bottom, 'long session keeps a bottom spacer');
    // Only a few tall rows are visible here, so hidden rows keep the bounded
    // legacy estimate instead of inheriting a huge average after a remount.
    assert.equal(Number.parseFloat(bottom.style.height), 24760);
  } finally { await view.close(); }
});

test('virtual layout corrections preserve the overlapping anchor row', async () => {
  const scroll = document.createElement('div');
  Object.defineProperties(scroll, {
    scrollTop: { configurable: true, writable: true, value: 100 },
    clientHeight: { configurable: true, value: 600 },
  });
  scroll.getBoundingClientRect = () => ({ top: 0, height: 600, bottom: 600, left: 0, right: 800, width: 800, x: 0, y: 0, toJSON: () => ({}) });
  const scrollRef = { current: scroll };
  const corrections = [];
  const view = await renderMessages(longSession(), { scrollRef, onCorrectScroll: delta => corrections.push(delta) });
  try {
    const positions = new Map();
    for (const node of view.container.querySelectorAll('.virtual-message-item')) {
      const id = node.querySelector('[data-message-id]').dataset.messageId;
      const index = Number(id.slice(1));
      positions.set(id, { top: index * 320, height: 320 });
    }
    patchVirtualLayout(view.container, positions);
    await measureVirtualMessages();
    corrections.length = 0;

    for (const [id, position] of positions) positions.set(id, { ...position, top: position.top + 500 });
    patchVirtualLayout(view.container, positions);
    const rows = [...view.container.querySelectorAll('.virtual-message-item')];
    const last = rows.at(-1);
    const rect = last.getBoundingClientRect();
    last.getBoundingClientRect = () => ({ ...rect, height: 321, bottom: rect.top + 321 });
    const resize = ResizeObserverStub.instances.at(-1);
    await act(async () => resize.callback([{ target: last }]));

    assert.deepEqual(corrections, [500]);
  } finally { await view.close(); }
});

test('corrected virtual scrolling keeps the anchor visible after window movement', async () => {
  const messages = longSession();
  const scroll = document.createElement('div');
  Object.defineProperties(scroll, {
    scrollTop: { configurable: true, writable: true, value: 3200 },
    clientHeight: { configurable: true, value: 600 },
  });
  scroll.getBoundingClientRect = () => ({ top: 0, height: 600, bottom: 600, left: 0, right: 800, width: 800, x: 0, y: 0, toJSON: () => ({}) });
  const expandedHeights = new Map();
  const actualHeight = index => (index % 2 ? 440 : 120) + (expandedHeights.get(`m${index}`) || 0);
  const measured = new Map();
  let layoutTop = 0;
  const dispatchScroll = async () => {
    layoutTop = scroll.scrollTop;
    await act(async () => scroll.dispatchEvent(new dom.window.Event('scroll')));
  };
  const indexOf = id => Number(id.slice(1));
  const positionOf = id => {
    const index = indexOf(id);
    const heightsList = messages.map(message => measured.get(String(message.id)) || estimateMessageHeight(message));
    const viewWindow = virtualMessageWindow(heightsList, layoutTop, scroll.clientHeight);
    if (index < viewWindow.start || index >= viewWindow.end) return null;
    let position = viewWindow.topHeight;
    for (let row = viewWindow.start; row < index; row++) position += actualHeight(row);
    return position;
  };
  const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const id = this.dataset?.virtualMessageId;
    if (!id) return originalRect.call(this);
    const index = indexOf(id);
    const position = positionOf(id);
    const height = actualHeight(index);
    const top = position === null ? 0 : position - scroll.scrollTop;
    return { top, height, bottom: top + height, left: 0, right: 600, width: 600, x: 0, y: top, toJSON: () => ({}) };
  };
  const syncMeasured = container => {
    for (const node of container.querySelectorAll('.virtual-message-item')) {
      const id = node.dataset.virtualMessageId;
      if (id) measured.set(id, actualHeight(indexOf(id)));
    }
  };
  const corrections = [];
  const correct = delta => {
    corrections.push(delta);
    scroll.scrollTop += delta;
  };
  const scrollRef = { current: scroll };
  let view;
  try {
    view = await renderMessages(messages, { scrollRef, onCorrectScroll: correct });
    layoutTop = scroll.scrollTop;
    await measureVirtualMessages(() => syncMeasured(view.container));
    // Applying a correction in a browser queues a real scroll event. Flush those
    // events until the corrected viewport and mounted window agree.
    for (let round = 0; round < 5; round++) {
      const before = corrections.length;
      await dispatchScroll();
      if (corrections.length === before) break;
    }
    const anchor = [...view.container.querySelectorAll('.virtual-message-item')]
      .map(node => ({ id: node.dataset.virtualMessageId, rect: node.getBoundingClientRect() }))
      .find(row => row.rect.bottom > 0);
    assert.ok(anchor, 'initial viewport has an anchor row');
    corrections.length = 0;

    const mounted = [...view.container.querySelectorAll('.virtual-message-item')];
    const expanded = mounted.map(node => node.dataset.virtualMessageId).filter(id => indexOf(id) < indexOf(anchor.id)).at(-1);
    assert.ok(expanded, 'a mounted row above the anchor can grow');
    expandedHeights.set(expanded, 500);
    await measureVirtualMessages(() => syncMeasured(view.container));
    assert.equal(corrections.length, 1, 'the measurement/window movement produces exactly one initial correction');
    syncMeasured(view.container);
    await dispatchScroll();
    assert.equal(corrections.length, 1, 'the real scroll event after correction does not correct again');

    const anchored = view.container.querySelector(`[data-virtual-message-id="${anchor.id}"]`);
    assert.ok(anchored, 'the original anchor row is still mounted');
    const rect = anchored.getBoundingClientRect();
    assert.ok(rect.bottom > 0 && rect.top < scroll.clientHeight, `anchor row remains in the viewport, got top=${rect.top} bottom=${rect.bottom}`);
  } finally {
    dom.window.HTMLElement.prototype.getBoundingClientRect = originalRect;
    if (view) await view.close();
  }
});

test('unmounted row estimates follow message content instead of visible outliers', async () => {
  const messages = longSession();
  messages[5] = { ...messages[5], text: Array.from({ length: 250 }, (_, line) => `FINAL FIX LINE ${line + 1}`).join('\n') };
  const offsetsRef = { current: [] };
  const view = await renderMessages(messages, { offsetsRef });
  try {
    assert.equal(offsetsRef.current[1] - offsetsRef.current[0], 320, 'ordinary user rows keep the legacy-scale estimate');
    assert.equal(offsetsRef.current[3] - offsetsRef.current[2], 320, 'ordinary assistant rows keep the legacy-scale estimate');
    assert.ok(offsetsRef.current[6] - offsetsRef.current[5] > 6000, 'a 250-line answer is estimated as a tall row before mounting');
  } finally { await view.close(); }
});

test('native scroll anchoring is disabled only for virtualized sessions', async () => {
  const scroll = document.createElement('div');
  const scrollRef = { current: scroll };
  const long = await renderMessages(longSession(), { scrollRef });
  try { assert.equal(scroll.style.overflowAnchor, 'none'); } finally { await long.close(); }
  const short = await renderMessages([{ id: 'u', role: 'user', text: '问' }], { scrollRef });
  try { assert.equal(scroll.style.overflowAnchor, ''); } finally { await short.close(); }
});

test('shrinking the chat viewport keeps bottom readers pinned without pulling history readers down', async () => {
  const scroll = document.createElement('div');
  let top = 0;
  Object.defineProperties(scroll, {
    scrollTop: {
      configurable: true,
      get: () => top,
      set: value => { top = Math.max(0, Math.min(value, scroll.scrollHeight - scroll.clientHeight)); },
    },
    clientHeight: { configurable: true, writable: true, value: 600 },
    scrollHeight: { configurable: true, writable: true, value: 1000 },
  });
  scroll.scrollTop = 400;
  const scrollRef = { current: scroll };
  const layouts = [];
  let away = false;
  const pin = () => { layouts.push(1); pinChatScroller(scroll, away); };
  const view = await renderMessages([{ id: 'u', role: 'user', text: '问' }], { scrollRef, onLayout: pin });
  try {
    const resize = ResizeObserverStub.instances.find(instance => instance.observed.has(scroll));
    assert.ok(resize, 'the scroller size is observed');
    assert.equal(scroll.scrollTop, 400, 'the reader starts exactly at the bottom');

    const count = layouts.length;
    scroll.clientHeight = 500;
    await act(async () => resize.callback([]));
    assert.ok(layouts.length > count, 'the shorter viewport publishes layout');
    assert.equal(scroll.scrollTop, 500, 'the bottom reader still sees the latest message');

    away = true;
    scroll.scrollTop = 200;
    const historyCount = layouts.length;
    scroll.clientHeight = 450;
    await act(async () => resize.callback([]));
    assert.ok(layouts.length > historyCount, 'the second resize also publishes layout');
    assert.equal(scroll.scrollTop, 200, 'a reader browsing history is not pulled back to the bottom');
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

test('streaming reasoning follows the latest text beyond 120 characters and viewport resizes', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const content = '思考内容 '.repeat(40);
  const render = (text, streaming) => act(async () => root.render(createElement(BlockRenderer, {
    blocks: [{ id: 'r', type: 'reasoning', content: text }], streaming, notify: () => {},
  })));
  try {
    await render(content, true);
    const preview = container.querySelector('.reasoning-preview');
    let width = 1400;
    Object.defineProperty(preview, 'scrollWidth', { get: () => width });
    await render(content + '最新输出', true);
    assert.equal(preview.textContent, content + '最新输出');
    assert.equal(preview.scrollLeft, width);
    const observer = ResizeObserverStub.instances.find(item => item.element === preview);
    assert.ok(observer);
    width = 1600;
    observer.callback();
    assert.equal(preview.scrollLeft, width, 'keeps the tail visible after a resize');
    await act(async () => container.querySelector('.reasoning-head').click());
    assert.equal(container.querySelector('.reasoning-plain').textContent, content + '最新输出');
    await render(content + '最新输出', false);
    assert.equal(observer.disconnected, true, 'stops observing when output ends');
    assert.equal(preview.scrollLeft, 0, 'finished reasoning returns to the beginning');
    await render(content + '历史内容', false);
    assert.equal(preview.scrollLeft, 0, 'inactive reasoning does not force scrolling');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('expanded reasoning caps excessive blank lines', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(BlockRenderer, {
      blocks: [{ id: 'r', type: 'reasoning', content: '\n\n第一段\n\n\n\n第二段\n\n\n' }],
      streaming: false,
      notify: () => {},
    })));
    await act(async () => container.querySelector('.reasoning-head').click());
    assert.equal(container.querySelector('.reasoning-plain').textContent, '第一段\n\n第二段');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('only the latest reasoning step follows within an expanded chain', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(BlockRenderer, {
      blocks: [{ id: 'r1', type: 'reasoning', content: '之前的思考' }, { id: 'r2', type: 'reasoning', content: '最新的思考' }],
      streaming: true, notify: () => {},
    })));
    await act(async () => container.querySelector('.chain-head').click());
    assert.deepEqual([...container.querySelectorAll('.reasoning-preview')].map(node => node.dataset.streaming), ['false', 'true']);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('chain summary stays neutral after a tool fails while details retain its status', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const blocks = [
    { id: 'r', type: 'reasoning', content: '尝试读取文件' },
    { id: 't', type: 'tool_call', name: 'read_file', args: {}, status: '失败', result: 'File not found' },
  ];
  const render = status => act(async () => root.render(createElement(BlockRenderer, {
    blocks: [blocks[0], { ...blocks[1], status }], notify: () => {},
  })));
  try {
    await render('执行中');
    assert.ok(container.querySelector('.chain-head .tool-icon.running'));
    await render('失败');
    const heading = container.querySelector('.chain-head');
    assert.equal(heading.querySelector('.tool-icon'), null);
    assert.ok(heading.querySelector('.lucide-list-tree'));
    assert.match(heading.textContent, /1 次思考 · 1 次工具/);
    await act(async () => heading.click());
    assert.ok(container.querySelector('.chain-steps .tool-icon.failed'));
    assert.equal(container.querySelector('.tool-status').textContent, '失败');
    await act(async () => container.querySelector('.tool-head').click());
    assert.match(container.querySelector('.tool-detail').textContent, /File not found/);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});


test('user document chips preview safely in a dialog and restore attachments when editing', async () => {
  const documents = [{ name: '参考.txt', size: 2100, text: '<script>alert(1)</script>\n附件内容' }];
  const payload = '这是哪个文件？\n\n```loopra-attachments\n' + JSON.stringify(documents) + '\n```';
  const edits = [];
  const view = await renderMessages([{ id: 'u', role: 'user', text: payload }], { onEdit: (...args) => edits.push(args) });
  try {
    const chip = view.container.querySelector('.message-context-chip');
    assert.ok(chip, view.container.innerHTML);
    assert.equal(chip.textContent, '参考.txt');
    assert.equal(chip.getAttribute('aria-haspopup'), 'dialog');
    assert.equal(view.container.querySelector('[role=dialog]'), null);
    assert.equal(view.container.querySelector('.msg-text').textContent, '这是哪个文件？');
    await act(async () => chip.click());
    assert.ok(view.container.querySelector('[role=dialog]'));
    assert.equal(view.container.querySelector('.message-context-body pre').textContent, documents[0].text);
    assert.equal(view.container.querySelector('script'), null);
    await act(async () => view.container.querySelector('[aria-label=关闭]').click());
    assert.equal(view.container.querySelector('[role=dialog]'), null);
    await act(async () => view.container.querySelector('[aria-label="重新编辑消息"]').click());
    assert.deepEqual(edits, [['这是哪个文件？', documents]]);
  } finally { await view.close(); }
});


test('images share the context chip row and open the image preview', async () => {
  const images = ['data:image/png;base64,first', 'data:image/png;base64,second'];
  const view = await renderMessages([{ id: 'u', role: 'user', text: '调用技能' , images }]);
  try {
    const chips = view.container.querySelectorAll('.message-context-image');
    assert.equal(chips.length, 2);
    assert.deepEqual([...view.container.querySelectorAll('.message-context-thumbnail')].map(image => image.src), images);
    assert.equal(view.container.querySelector('.user-images'), null);
    await act(async () => chips[1].click());
    assert.equal(imagePreviews.at(-1), images[1]);
  } finally { await view.close(); }
});
