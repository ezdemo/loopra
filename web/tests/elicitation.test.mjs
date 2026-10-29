import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const transpile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const helperUrl = dataUrl(transpile(await readFile(new URL('../src/elicitation.ts', import.meta.url), 'utf8')));
let source = transpile(await readFile(new URL('../src/components/ElicitationForm.tsx', import.meta.url), 'utf8'));
source = source.replaceAll("'react'", JSON.stringify(import.meta.resolve('react'))).replaceAll('"react/jsx-runtime"', JSON.stringify(import.meta.resolve('react/jsx-runtime')))
  .replaceAll("'../elicitation'", JSON.stringify(helperUrl)).replace("import '../elicitation.css';", '');
const { default: ElicitationForm } = await import(dataUrl(source));
const { elicitationContent, elicitationError, elicitationPages } = await import(helperUrl);

const request = { elicitationRequestId: 'question-1', message: '午餐吃什么？', schema: { required: ['food'], properties: {
  food: { type: 'string', title: '选择午餐', oneOf: [{ const: 'chicken', title: '黄焖鸡', description: '米饭套餐' }, { const: 'kfc', title: '肯德基' }] },
  food_note: { type: 'string', title: '补充说明' },
} } };

function render(input = request, onAnswer = async () => {}) {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(createElement(ElicitationForm, { request: input, onAnswer })));
  return { container, close() { act(() => root.unmount()); container.remove(); } };
}
const click = async node => act(async () => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
const submit = async view => act(async () => view.container.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
async function input(node, value) {
  const prototype = node.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value);
  await act(async () => node.dispatchEvent(new dom.window.Event('input', { bubbles: true })));
}

test('Codex questions show labelled options and return the selected wire value with a note', async () => {
  const replies = [];
  const view = render(request, async (...answer) => { replies.push(answer); });
  try {
    assert.equal(view.container.querySelectorAll('[aria-checked="true"]').length, 0, 'No answer is chosen automatically');
    assert.match(view.container.textContent, /黄焖鸡/);
    await click(view.container.querySelector('[role="radio"]'));
    await input(view.container.querySelector('textarea[aria-label="补充说明"]'), '少辣');
    await submit(view);
    assert.deepEqual(replies, [['accept', { food: 'chicken', food_note: '少辣' }]]);
  } finally { view.close(); }
});

test('required answers are validated and skipping sends no invented answer', async () => {
  const replies = [];
  const view = render(request, async (...answer) => { replies.push(answer); });
  try {
    await submit(view);
    assert.equal(replies.length, 0);
    assert.match(view.container.querySelector('[role="alert"]').textContent, /选择午餐/);
    await click(view.container.querySelector('.elicitation-skip'));
    assert.deepEqual(replies, [['decline', {}]]);
  } finally { view.close(); }
});

test('booleans, multiple selection, numbers and secret fields retain their types', async () => {
  const replies = [];
  const typed = { ...request, schema: { required: ['delivery'], properties: {
    delivery: { type: 'boolean', title: '配送' }, count: { type: 'integer', title: '数量', minimum: 1 },
    sides: { type: 'array', title: '配菜', items: { type: 'string', enum: ['rice', 'tea'] } },
    secret: { type: 'string', title: '备注', _meta: { codex: { isSecret: true } } },
  } } };
  const view = render(typed, async (...answer) => { replies.push(answer); });
  try {
    await click(view.container.querySelectorAll('[role="radio"]')[1]);
    await click(view.container.querySelector('.elicitation-next'));
    await input(view.container.querySelector('input[type="number"]'), '2');
    await click(view.container.querySelector('.elicitation-next'));
    await click(view.container.querySelector('[role="checkbox"]'));
    await click(view.container.querySelector('.elicitation-next'));
    assert.ok(view.container.querySelector('input[type="password"]'));
    await submit(view);
    assert.deepEqual(replies, [['accept', { delivery: false, count: 2, sides: ['rice'] }]]);
  } finally { view.close(); }
});

test('a rejected submission keeps the question open and allows retry', async () => {
  let calls = 0;
  const view = render(request, async () => { calls++; if (calls === 1) throw new Error('网络错误'); });
  try {
    await click(view.container.querySelector('[role="radio"]'));
    await submit(view);
    assert.match(view.container.querySelector('[role="alert"]').textContent, /网络错误/);
    assert.equal(view.container.querySelector('.elicitation-submit').disabled, false);
    await submit(view);
    assert.equal(calls, 2);
  } finally { view.close(); }
});

test('content excludes unknown fields and preserves false and zero', () => {
  const input = { ...request, schema: { properties: { flag: { type: 'boolean' }, count: { type: 'number' }, text: { type: 'string' } } } };
  assert.deepEqual(elicitationContent(input, { flag: false, count: 0, text: '', unknown: 'drop' }), { flag: false, count: 0 });
  assert.match(elicitationError(request, { food: 'invalid' }), /有效选项/);
});

test('pages keep each question with its note, preserve answers across navigation and submit once', async () => {
  const replies = [];
  const questions = { ...request, schema: { required: ['food', 'time'], properties: {
    food_note: { type: 'string', title: '口味补充', _meta: { codex: { role: 'user_note', questionId: 'food' } } },
    food: request.schema.properties.food,
    time: { type: 'string', title: '多久吃完？', enum: ['15分钟', '30分钟'] },
  } } };
  const view = render(questions, async (...answer) => replies.push(answer));
  try {
    assert.match(view.container.textContent, /问题 1 \/ 2/);
    assert.ok(view.container.querySelector('textarea[aria-label="口味补充"]'));
    assert.equal(view.container.querySelector('[aria-label="多久吃完？"]'), null);
    await click(view.container.querySelector('[role="radio"]'));
    await input(view.container.querySelector('textarea'), '少辣');
    view.container.querySelector('.elicitation-fields').scrollTop = 100;
    await click(view.container.querySelector('.elicitation-next'));
    assert.match(view.container.textContent, /问题 2 \/ 2/);
    assert.equal(view.container.querySelector('.elicitation-fields').scrollTop, 0);
    await click(view.container.querySelectorAll('[role="radio"]')[1]);
    await click(view.container.querySelector('.elicitation-prev'));
    assert.equal(view.container.querySelector('[role="radio"]').getAttribute('aria-checked'), 'true');
    assert.equal(view.container.querySelector('textarea').value, '少辣');
    await click(view.container.querySelector('.elicitation-next'));
    assert.equal(view.container.querySelector('[role="alert"]'), null, 'Next must not submit as it becomes the last page');
    await submit(view);
    assert.deepEqual(replies, [['accept', { food: 'chicken', food_note: '少辣', time: '30分钟' }]]);
  } finally { view.close(); }
});

test('final validation returns to an unanswered earlier question', async () => {
  const view = render({ ...request, schema: { ...request.schema, properties: { ...request.schema.properties, time: { type: 'string', title: '时间' } } } });
  try {
    await click(view.container.querySelector('.elicitation-next'));
    await submit(view);
    assert.match(view.container.textContent, /问题 1 \/ 2/);
    assert.match(view.container.querySelector('[role="alert"]').textContent, /选择午餐/);
  } finally { view.close(); }
});

test('Claude custom answers share their original question page and keep their wire keys', async () => {
  const replies = [];
  const questions = { ...request, message: 'Please answer the following questions.', schema: { properties: {
    question_0_custom: { type: 'string', title: 'Other', description: 'Type your own answer, or add a note to the option you chose above (optional).' },
    question_0: { type: 'string', title: '午饭', oneOf: [{ const: '面食', title: '面食' }, { const: '米饭', title: '米饭' }] },
    question_1: { type: 'array', title: '饮料', items: { anyOf: [{ const: '茶', title: '茶' }, { const: '咖啡', title: '咖啡' }] } },
    question_1_custom: { type: 'string', title: 'Other' },
  } } };
  const view = render(questions, async (...answer) => replies.push(answer));
  try {
    assert.match(view.container.textContent, /问题 1 \/ 2/);
    await click(view.container.querySelector('[role="radio"]'));
    await input(view.container.querySelector('textarea[aria-label="Other"]'), '少辣');
    await click(view.container.querySelector('.elicitation-next'));
    assert.match(view.container.textContent, /问题 2 \/ 2/);
    assert.ok(view.container.querySelector('[role="checkbox"]'));
    await input(view.container.querySelector('textarea[aria-label="Other"]'), '白水');
    await click(view.container.querySelector('.elicitation-prev'));
    assert.equal(view.container.querySelector('[role="radio"]').getAttribute('aria-checked'), 'true');
    assert.equal(view.container.querySelector('textarea').value, '少辣');
    await click(view.container.querySelector('.elicitation-next'));
    assert.equal(view.container.querySelector('textarea').value, '白水');
    await submit(view);
    assert.deepEqual(replies, [['accept', { question_0: '面食', question_0_custom: '少辣', question_1_custom: '白水' }]]);
  } finally { view.close(); }
});

test('unrelated or orphan custom fields remain separate questions', () => {
  const questions = { ...request, schema: { properties: {
    profile: { type: 'string' }, profile_custom: { type: 'string' }, question_9_custom: { type: 'string', title: 'Other' },
  } } };
  assert.deepEqual(elicitationPages(questions).map(page => page.id), ['profile', 'profile_custom', 'question_9_custom']);
});
