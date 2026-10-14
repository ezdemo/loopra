import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => { dom.window.close(); for (const [key, value] of previous) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; } });
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const reactUrl = import.meta.resolve('react');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
async function sourceUrl(name, dependencies = {}) {
  const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
  for (const [key, value] of Object.entries({ react: reactUrl, 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), ...dependencies })) outputText = outputText.replaceAll(`'${key}'`, JSON.stringify(value)).replaceAll(`"${key}"`, JSON.stringify(value));
  return dataUrl(outputText);
}
const icons = dataUrl('export const Copy=()=>null, ChevronRight=()=>null, Search=()=>null, Download=()=>null, FileText=()=>null, ListTree=()=>null, RefreshCw=()=>null;');
const markdown = dataUrl(`import { createElement } from ${JSON.stringify(reactUrl)}; export const copyText = async (text, notify) => { await navigator.clipboard.writeText(text); notify('已复制'); }; export default ({ text }) => createElement('div', { className: 'markdown' }, text);`);
const rawUrl = await sourceUrl('components/RawSessionRecords.tsx', { 'lucide-react': icons, '../session-records': await sourceUrl('session-records.ts'), './Markdown': markdown });
const { default: RawSessionRecords } = await import(rawUrl);
const nextui = dataUrl(`import { createElement } from ${JSON.stringify(reactUrl)};
export const Button = ({ children, onPress, isDisabled, isLoading, startContent, ...rest }) => createElement('button', { type: 'button', disabled: !!isDisabled || !!isLoading, onClick: onPress, ...rest }, startContent, children);
export const Modal = ({ children }) => createElement('div', { role: 'dialog' }, children);
export const ModalContent = ({ children, className }) => createElement('div', { className }, children);
export const ModalBody = ModalContent, ModalHeader = ModalContent;`);
const controls = dataUrl(`import { useEffect, useState } from ${JSON.stringify(reactUrl)};
export const query = value => new URLSearchParams(value).toString(); export const RemoteState = () => null;
export function useRemote(api, path, revision) { const [state, setState] = useState({ loading: true }); useEffect(() => { let live = true; api.request(path).then(data => { if (live) setState({ data, loading: false }); }); return () => { live = false; }; }, [api, path, revision]); return state; }`);
const { default: SessionDetails } = await import(await sourceUrl('components/SessionDetails.tsx', { '@nextui-org/react': nextui, 'lucide-react': icons, '../backend': dataUrl('export const sessionQuery = () => "workspaceHash=test&sessionName=test";'), './RemoteControls': controls, '../session-prompt': await sourceUrl('session-prompt.ts'), './Markdown': markdown, './RawSessionRecords': rawUrl }));
const messages = [{ role: 'user', content: 'check the project' }, { role: 'assistant', content: 'Checking.', tool_calls: [{ id: 'a', name: 'bash', arguments: { command: 'git status' } }] }, { role: 'tool', tool_call_id: 'a', content: 'unique-result: main branch' }];
let copied;
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { copied = text; } } });
async function mount(Component, props) {
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  await act(async () => root.render(createElement(Component, props)));
  return { container, async close() { await act(async () => root.unmount()); container.remove(); } };
}
test('record filters/search work and full tool data renders only after expansion', async () => {
  const view = await mount(RawSessionRecords, { messages, notify() {} });
  try {
    assert.equal(view.container.querySelectorAll('.record-row').length, 3);
    assert.equal(view.container.querySelector('.record-row-detail'), null);
    await act(async () => { [...view.container.querySelectorAll('.record-kind-filters button')].find(button => button.textContent.startsWith('工具')).click(); });
    assert.equal(view.container.querySelectorAll('.record-row').length, 1);
    const input = view.container.querySelector('input');
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'unique-result'); input.dispatchEvent(new window.Event('input', { bubbles: true })); });
    assert.equal(view.container.querySelectorAll('.record-row').length, 1);
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'no-matching-content'); input.dispatchEvent(new window.Event('input', { bubbles: true })); });
    assert.equal(view.container.querySelectorAll('.record-row').length, 0);
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'unique-result'); input.dispatchEvent(new window.Event('input', { bubbles: true })); });
    const row = view.container.querySelector('.record-row');
    await act(async () => { row.open = true; row.dispatchEvent(new window.Event('toggle')); });
    assert.match(view.container.querySelector('.record-row-detail').textContent, /调用参数.*git status.*工具结果.*unique-result/s);
    await act(async () => { view.container.querySelector('.record-detail-actions button').click(); });
    assert.equal(JSON.parse(copied).result.tool_call_id, 'a');
  } finally { await view.close(); }
});
test('the overview can navigate beyond the initially mounted 200 records after filtering', async () => {
  const view = await mount(RawSessionRecords, { messages: Array.from({ length: 300 }, (_, index) => ({ role: 'user', content: `message-${index}` })), notify() {} });
  try {
    assert.equal(view.container.querySelectorAll('.record-row').length, 200);
    await act(async () => { [...view.container.querySelectorAll('.record-kind-filters button')].find(button => button.textContent.startsWith('工具')).click(); });
    assert.equal(view.container.querySelectorAll('.record-row').length, 0);
    await act(async () => { view.container.querySelector('[aria-label="定位输入记录 299"]').click(); });
    assert.match(view.container.querySelector('.record-row.is-active').textContent, /message-298/);
    assert.equal(document.activeElement.closest('.record-row'), view.container.querySelector('.record-row.is-active'));
  } finally { await view.close(); }
});
test('only records and prompt tabs remain, switching reuses fetched data, and prompt source/copy are exact', async () => {
  const calls = [];
  const prompt = '# Rules\n\n- Preserve this exact text.\n';
  const api = { request: async path => { calls.push(path); return path.includes('/prompt?') ? { content: prompt } : messages; } };
  const view = await mount(SessionDetails, { api, session: { name: 'test', title: 'test', workspaceHash: 'test' }, onClose() {}, notify() {} });
  try {
    assert.deepEqual([...view.container.querySelectorAll('[role="tab"]')].map(button => button.textContent), ['原始记录', '系统提示词']);
    assert.equal(calls.length, 2);
    await act(async () => { view.container.querySelector('#session-record-tab-prompt').click(); });
    assert.equal(view.container.querySelector('.markdown').textContent, prompt);
    await act(async () => { [...view.container.querySelectorAll('button')].find(button => button.textContent === '原文').click(); });
    assert.equal(view.container.querySelector('.session-prompt-source').textContent, prompt);
    await act(async () => { [...view.container.querySelectorAll('button')].find(button => button.textContent === '复制提示词').click(); });
    assert.equal(copied, prompt);
    await act(async () => { view.container.querySelector('#session-record-tab-events').click(); });
    assert.equal(calls.length, 2);
    assert.ok(view.container.querySelector('.record-row'));
    assert.equal(calls.some(path => path.includes('snapshots')), false);
  } finally { await view.close(); }
});
