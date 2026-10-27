import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
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
const { Simulate } = await import('react-dom/test-utils');
async function load(name) {
  const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
  for (const dependency of ['react', 'react-dom', 'react/jsx-runtime', 'lucide-react']) {
    outputText = outputText.replaceAll(`'${dependency}'`, JSON.stringify(import.meta.resolve(dependency))).replaceAll(`"${dependency}"`, JSON.stringify(import.meta.resolve(dependency)));
  }
  return import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
}
const { default: ComposerQueue } = await load('components/ComposerQueue.tsx');
const { removeQueued, moveQueued } = await load('message-queue.ts');
const message = (id, text = id) => ({ id, text, context: { files: [], projects: [], skills: [] } });

function render(messages) {
  let queue = { session: messages };
  const edits = [], guides = [];
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const draw = () => root.render(createElement(ComposerQueue, {
    queue: queue.session,
    onRemove: id => { queue = removeQueued(queue, 'session', id); draw(); },
    onGuide: id => guides.push(id),
    onEdit: id => {
      const item = queue.session.find(item => item.id === id);
      if (!item) return;
      edits.push(item);
      queue = removeQueued(queue, 'session', id); draw();
    },
    onMove: (id, target) => { queue = moveQueued(queue, 'session', id, target); draw(); },
  }));
  act(draw);
  return {
    container, edits, guides, queue: () => queue.session,
    click: selector => act(() => {
      const target = document.querySelector(selector);
      assert.ok(target, `missing control: ${selector}`); target.click();
    }),
    unmount: () => { act(() => root.unmount()); container.remove(); },
  };
}

test('rows show compact previews, guide, withdraw and more; editing stays in the menu', () => {
  const view = render([message('a', 'long prompt '.repeat(200)), message('b')]);
  try {
    assert.equal(view.container.querySelectorAll('.composer-queue-row').length, 2);
    assert.ok(view.container.querySelector('.composer-queue-text').textContent.length <= 160);
    assert.equal(view.container.querySelector('.composer-queue-editor'), null);
    view.click('[aria-label="第 1 条消息的更多操作"]');
    const menu = document.querySelector('[role="menu"]');
    assert.ok(menu);
    assert.equal(menu.parentElement, document.body, 'menu must escape the scroll container');
    assert.equal(menu.querySelector('button').textContent, '编辑消息');
    assert.equal(menu.querySelectorAll('button')[1].disabled, true);
    act(() => document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.equal(document.querySelector('[role="menu"]'), null);
    view.click('.composer-queue-guide');
    assert.deepEqual(view.guides, ['a']);
    view.click('[aria-label="撤回第 1 条消息"]');
    assert.deepEqual(view.queue().map(item => item.id), ['b']);
  } finally { view.unmount(); }
});

test('menu editing withdraws the selected entry for the main composer with all its attachments', () => {
  const attached = { ...message('a'), context: { files: ['report.pdf', 'image.png'], projects: [], skills: [], attachments: [{ name: 'report.pdf', text: 'report' }, { name: 'image.png', image: 'data:image/png;base64,abc' }] } };
  const view = render([attached, message('b')]);
  try {
    view.click('[aria-label="第 1 条消息的更多操作"]');
    view.click('[role="menuitem"]');
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.deepEqual(view.edits, [attached]);
    assert.deepEqual(view.queue().map(item => item.id), ['b']);
    assert.equal(view.container.querySelector('textarea'), null);
    assert.equal(view.container.querySelector('.composer-queue-guide').disabled, false);
  } finally { view.unmount(); }
});

test('clicking message text or attachments keeps entries queued until menu editing is selected', () => {
  const attached = { ...message('a', ''), context: { files: [], projects: [], skills: [], attachments: [{ name: 'image.png', image: 'image content' }] } };
  const text = message('b', 'queued prompt');
  const view = render([attached, text]);
  try {
    assert.match(view.container.textContent, /仅附件消息/);
    view.click('.composer-queue-preview');
    view.click('.composer-queue-attachments');
    view.click('[data-queue-id="b"] .composer-queue-text');
    assert.deepEqual(view.edits, []);
    assert.deepEqual(view.queue(), [attached, text]);
    view.click('[aria-label="第 1 条消息的更多操作"]');
    view.click('[role="menuitem"]');
    assert.deepEqual(view.edits, [attached]);
    assert.deepEqual(view.queue(), [text]);
  } finally { view.unmount(); }
});

test('menu sorting and drag sorting both move the original queue entries', () => {
  const view = render([message('a'), message('b'), message('c')]);
  try {
    view.click('[aria-label="第 1 条消息的更多操作"]');
    act(() => [...document.querySelectorAll('[role="menuitem"]')].find(button => button.textContent === '下移').click());
    assert.deepEqual(view.queue().map(item => item.id), ['b', 'a', 'c']);
    const transfer = { setData: () => {}, effectAllowed: '', dropEffect: '' };
    act(() => Simulate.dragStart(view.container.querySelectorAll('.composer-queue-preview')[2], { dataTransfer: transfer }));
    assert.equal(view.container.querySelector('[data-queue-id="c"]').draggable, true);
    assert.ok(view.container.querySelector('[data-queue-id="c"]').classList.contains('dragging'));
    act(() => Simulate.dragOver(view.container.querySelector('li'), { dataTransfer: transfer }));
    assert.ok(view.container.querySelector('li').classList.contains('drag-over'));
    act(() => Simulate.drop(view.container.querySelector('li'), { dataTransfer: transfer }));
    assert.deepEqual(view.queue().map(item => item.id), ['c', 'b', 'a']);
    assert.equal(view.container.querySelector('.dragging, .drag-over'), null);
  } finally { view.unmount(); }
});

test('row drag feedback clears when leaving a target or cancelling the drag', () => {
  const view = render([message('a'), message('b'), message('c')]);
  try {
    const source = view.container.querySelector('[data-queue-id="a"]');
    const target = view.container.querySelector('[data-queue-id="b"]');
    const transfer = { setData: () => {}, effectAllowed: '', dropEffect: '' };
    act(() => Simulate.dragStart(source, { dataTransfer: transfer }));
    act(() => Simulate.dragOver(source, { dataTransfer: transfer }));
    assert.equal(source.classList.contains('drag-over'), false);
    act(() => Simulate.dragOver(target, { dataTransfer: transfer }));
    act(() => Simulate.dragLeave(target, { relatedTarget: target.querySelector('button') }));
    assert.ok(target.classList.contains('drag-over'), 'moving between controls in one row keeps its feedback');
    act(() => Simulate.dragLeave(target, { relatedTarget: null }));
    assert.equal(target.classList.contains('drag-over'), false);
    act(() => Simulate.dragOver(target, { dataTransfer: transfer }));
    act(() => Simulate.dragEnd(source, { dataTransfer: transfer }));
    assert.equal(view.container.querySelector('.dragging, .drag-over'), null);
    assert.deepEqual(view.queue().map(item => item.id), ['a', 'b', 'c']);
    act(() => Simulate.drop(target, { dataTransfer: transfer }));
    assert.deepEqual(view.queue().map(item => item.id), ['a', 'b', 'c'], 'external drops do not reorder queued messages');
  } finally { view.unmount(); }
});
