import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, mock, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// Legacy Chat.vue kept a floating log stack fed by `log` SSE events plus the
// global `copy-success` / `app-notify` window events. Assert the ported rules:
// DEBUG is dropped, entries expire, and a click copies `[HH:mm:ss] text`.
const source = await readFile(new URL('../src/chat-logs.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { CHAT_LOG_LIMIT, CHAT_LOG_TIMEOUT_MS, appendChatLog, chatLogCopyText, chatLogLevel, chatLogText, removeChatLog } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

// The hook and component need a DOM; all top-level awaits stay before the
// cleanup hook so `node --test` cannot tear the document down mid-suite.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const reactUrl = import.meta.resolve('react');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
let chatLogsUrl;
{
  const moduleSource = await readFile(new URL('../src/components/ChatLogs.tsx', import.meta.url), 'utf8');
  let { outputText: componentText } = ts.transpileModule(moduleSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
  for (const [specifier, url] of Object.entries({ react: reactUrl, 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), '../chat-logs': dataUrl(outputText) })) {
    componentText = componentText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
  }
  chatLogsUrl = dataUrl(componentText);
}
const { default: ChatLogs, useChatLogs } = await import(chatLogsUrl);
after(() => {
  dom.window.close();
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
});

// Mounts the hook together with the real component so the tests exercise the
// same wiring App.tsx uses (state -> stack -> copy/dismiss callbacks).
async function mountLogs() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const copied = [];
  let api;
  function Harness() {
    api = useChatLogs();
    return createElement(ChatLogs, { logs: api.logs, onDismiss: api.dismiss, onCopy: text => copied.push(text) });
  }
  await act(async () => root.render(createElement(Harness)));
  return {
    api: () => api,
    copied,
    bars: () => [...document.querySelectorAll('.log-bar')],
    async close() { await act(async () => root.unmount()); container.remove(); }
  };
}

test('log levels mirror the legacy INFO/WARN/ERROR filter', () => {
  assert.equal(CHAT_LOG_TIMEOUT_MS, 6000);
  assert.equal(chatLogLevel(undefined), 'info');
  assert.equal(chatLogLevel('info'), 'info');
  assert.equal(chatLogLevel('WARN'), 'warn');
  assert.equal(chatLogLevel('warning'), 'warn');
  assert.equal(chatLogLevel('ERROR'), 'error');
  assert.equal(chatLogLevel('fatal'), 'error');
  assert.equal(chatLogLevel('DEBUG'), null, 'DEBUG entries never render');
});

test('log text accepts message, content and plain strings', () => {
  assert.equal(chatLogText({ message: '折叠完成' }), '折叠完成');
  assert.equal(chatLogText({ content: '来自 content' }), '来自 content');
  assert.equal(chatLogText('后台进程已关闭'), '后台进程已关闭');
  assert.equal(chatLogText(null), '');
  assert.equal(chatLogText({}), '');
});

test('the stack prepends entries, de-duplicates ids and caps its length', () => {
  const entries = Array.from({ length: CHAT_LOG_LIMIT }, (_, index) => ({ id: `old-${index}`, level: 'info', text: `旧 ${index}`, time: index }));
  const next = appendChatLog(entries, { id: 'new', level: 'warn', text: '新日志', time: 99 });
  assert.equal(next.length, CHAT_LOG_LIMIT);
  assert.equal(next[0].id, 'new');
  assert.equal(next.at(-1).id, `old-${CHAT_LOG_LIMIT - 2}`);
  const replaced = appendChatLog(next, { id: 'new', level: 'error', text: '替换', time: 100 });
  assert.equal(replaced.filter(entry => entry.id === 'new').length, 1);
  assert.equal(replaced[0].text, '替换');
  assert.deepEqual(removeChatLog(replaced, 'new').some(entry => entry.id === 'new'), false);
});

test('clicking a bar copies the legacy [time] text line', () => {
  const time = new Date(2026, 9, 13, 9, 5, 7).getTime();
  const line = chatLogCopyText({ text: '已复制', time });
  assert.match(line, /^\[09:05:07\] 已复制$/);
});

test('window copy-success and app-notify events feed the floating stack', async () => {
  const view = await mountLogs();
  try {
    await act(async () => { window.dispatchEvent(new dom.window.CustomEvent('copy-success', { detail: '已复制代码' })); });
    await act(async () => { window.dispatchEvent(new dom.window.CustomEvent('app-notify', { detail: '任务完成' })); });
    const bars = view.bars();
    assert.equal(bars.length, 2);
    assert.match(bars[0].textContent, /任务完成/, 'newest entry renders on top');
    assert.match(bars[1].textContent, /✅ 已复制代码/);
    assert.equal(bars[0].classList.contains('log-info'), true);
  } finally { await view.close(); }
});

test('streamed log events reach the stack and keep their level', async () => {
  // App.tsx forwards `log` SSE payloads straight into the hook; mirror that
  // call shape so the level mapping and text extraction are exercised together.
  const view = await mountLogs();
  try {
    await act(async () => view.api().push({ level: 'WARN', content: '上下文接近折叠阈值' }));
    await act(async () => view.api().push({ level: 'INFO', message: '工具已完成' }));
    await act(async () => view.api().push({ level: 'ERROR', text: '工具失败' }));
    const bars = view.bars();
    assert.deepEqual(bars.map(bar => bar.className.replace('log-bar ', '')), ['log-error', 'log-info', 'log-warn']);
    assert.match(bars[0].textContent, /工具失败/);
    assert.match(bars[2].textContent, /上下文接近折叠阈值/);
  } finally { await view.close(); }
});

test('DEBUG payloads are dropped and the close button dismisses a bar', async () => {
  const view = await mountLogs();
  try {
    await act(async () => view.api().push({ level: 'DEBUG', message: '看不见的日志' }));
    assert.equal(view.bars().length, 0);
    await act(async () => view.api().push({ level: 'WARN', message: '注意水位' }));
    assert.equal(view.bars().length, 1);
    assert.equal(view.bars()[0].classList.contains('log-warn'), true);
    await act(async () => document.querySelector('.log-bar-close').click());
    assert.equal(view.bars().length, 0);
  } finally { await view.close(); }
});

test('clicking a bar copies its formatted line without dismissing it', async () => {
  const view = await mountLogs();
  try {
    await act(async () => view.api().push({ text: '复制我' }));
    await act(async () => view.bars()[0].click());
    assert.equal(view.copied.length, 1);
    assert.match(view.copied[0], /^\[\d{2}:\d{2}:\d{2}\] 复制我$/);
    assert.equal(view.bars().length, 1, 'copying leaves the bar visible');
  } finally { await view.close(); }
});

test('entries expire after the legacy six seconds', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const view = await mountLogs();
  try {
    await act(async () => view.api().push('会过期的日志'));
    assert.equal(view.bars().length, 1);
    await act(async () => { mock.timers.tick(CHAT_LOG_TIMEOUT_MS + 1); });
    assert.equal(view.bars().length, 0);
  } finally {
    await view.close();
    mock.timers.reset();
  }
});
