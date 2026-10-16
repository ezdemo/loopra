import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// The terminal panel mirrors the legacy BashSessionManager: list background
// commands, copy the command/workdir, read a log and stop a running process.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, navigator: dom.window.navigator, ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });

const { act, createElement, useState } = await import('react');
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
export const Modal = ({ isOpen, children, 'aria-label': label }) => isOpen ? createElement('div', { role: 'dialog', 'aria-label': label }, children) : null;
export const ModalContent = ({ children }) => createElement('div', null, children);
export const ModalBody = ModalContent;
export const ModalHeader = ModalContent;
export const ModalFooter = ModalContent;
`);
const iconsStub = dataUrl('export const Copy=()=>null;export const Maximize=()=>null;export const RefreshCw=()=>null;export const SquareTerminal=()=>null;export const X=()=>null;');
const uiStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const IconButton = ({ label, children, onClick }) => createElement('button', { type: 'button', 'aria-label': label, onClick }, children);
`);
const controlsStub = dataUrl(`
const React = await import(${JSON.stringify(reactUrl)});
export const errorText = cause => cause instanceof Error ? cause.message : String(cause);
export const query = values => new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])).toString();
export function useRemote() { return { data: undefined, error: '', loading: false }; }
export const RemoteState = () => null;
`);
const stubPanel = dataUrl('export default () => null;');
const workspaceEventsStub = dataUrl('export const watchWorkspaceChanges = () => () => {};');
const panelResizeStub = dataUrl('export const DEFAULT_PANEL_WIDTH = 452; export const WIDE_PANEL_WIDTH = 560; export const resizePanelWidth = width => width;');
const libStub = dataUrl(`
const React = await import(${JSON.stringify(reactUrl)});
export function useLocalState(_key, initial) { return React.useState(initial); }
`);
const bashUrl = await sourceUrl('bash-sessions.ts');
const bashStateUrl = await sourceUrl('useBashSessions.ts', { './bash-sessions': bashUrl });
const panelsUrl = await sourceUrl('components/Panels.tsx', {
  '@nextui-org/react': nextuiStub, 'lucide-react': iconsStub, './ui': uiStub, './RemoteControls': controlsStub,
  './FilesPanel': stubPanel, './GitTools': stubPanel, './SchedulePanel': stubPanel, './SubAgentsPanel': stubPanel,
  './ProjectCapabilities': stubPanel, './DiffView': stubPanel, '../bash-sessions': bashUrl, '../lib': libStub, '../panel-resize': panelResizeStub, '../useBashSessions': bashStateUrl, '../workspace-events': workspaceEventsStub,
});
const { TerminalPanel } = await import(panelsUrl);
const taskLogUrl = await sourceUrl('components/BackgroundTaskLog.tsx', { '@nextui-org/react': nextuiStub, '../bash-sessions': bashUrl });
const { default: BackgroundTasks } = await import(await sourceUrl('components/BackgroundTasks.tsx', {
  'lucide-react': iconsStub, './Panels': panelsUrl, '../useBashSessions': bashStateUrl, './BackgroundTaskLog': taskLogUrl,
}));

const sessions = [
  { sessionId: 's-1', workspace: 'C:/code/loopra', command: 'pnpm build', workdir: 'C:/code/loopra/loopra-front', startedAt: Date.now() - 90_000, status: 'running' },
  { sessionId: 's-2', workspace: 'C:/code/loopra', command: 'sleep 1', workdir: 'C:/code/loopra', startedAt: Date.now() - 900_000, status: 'completed' },
];

async function mount({ floating = false, initialSessions = sessions } = {}) {
  let currentSessions = initialSessions;
  let hold = false;
  globalThis.__calls = []; globalThis.__notify = []; globalThis.__copied = [];
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText: async text => { globalThis.__copied.push(text); } } });
  const api = {
    request: (path, method = 'GET', body) => {
      globalThis.__calls.push({ path, method, body });
      if (hold) return new Promise(() => {});
      if (path.startsWith('/agent/bash-sessions/log')) return Promise.resolve({ output: 'build ok' });
      return Promise.resolve(currentSessions);
    },
  };
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  function Floating() {
    const [open, setOpen] = useState(false);
    return createElement(BackgroundTasks, { api, workspaceHash: 'hash 1', connected: true, open, onOpenChange: setOpen, notify: () => {} }, createElement('textarea', { 'aria-label': '输入消息' }));
  }
  await act(async () => root.render(floating ? createElement(Floating) : createElement(TerminalPanel, { api, workspaceHash: 'hash 1', onClose: () => {}, notify: message => globalThis.__notify.push(message) })));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return { container, root, updateSessions(value) { currentSessions = value; }, holdRequests() { hold = true; }, async close() { await act(async () => root.unmount()); container.remove(); } };
}

test('lists background sessions with the legacy summary and log output', async () => {
  const view = await mount();
  try {
    assert.ok(globalThis.__calls.some(call => call.path === '/agent/bash-sessions?workspaceHash=hash%201'));
    assert.ok(globalThis.__calls.some(call => call.path === '/agent/bash-sessions/log?workspaceHash=hash%201&sessionId=s-1'));
    const text = view.container.textContent;
    assert.match(text, /1 个运行中 · 共 2 个进程/);
    assert.match(text, /pnpm build/);
    assert.match(text, /C:\/code\/loopra\/loopra-front/);
    assert.match(text, /已结束/);
    assert.match(text, /build ok/);
  } finally { await view.close(); }
});

test('clicking a task information block selects its logs', async () => {
  const view = await mount();
  try {
    await act(async () => { view.container.querySelector('[aria-label="查看日志 s-2"]').click(); });
    assert.ok(globalThis.__calls.some(call => call.path === '/agent/bash-sessions/log?workspaceHash=hash%201&sessionId=s-2'));
    assert.match(view.container.querySelector('.bash-row.selected').textContent, /sleep 1/);
  } finally { await view.close(); }
});

test('stopping a process posts the session id for the active workspace', async () => {
  const view = await mount();
  try {
    await act(async () => { view.container.querySelector('[aria-label="终止任务 s-1"]').click(); await Promise.resolve(); });
    assert.ok(globalThis.__calls.some(call => call.method === 'POST' && call.path === '/agent/bash-sessions/terminate' && JSON.stringify(call.body) === JSON.stringify({ sessionId: 's-1', workspaceHash: 'hash 1' })));
  } finally { await view.close(); }
});

test('each task terminates by its own id without changing the task selected for logs', async () => {
  const view = await mount({ initialSessions: sessions.map(task => ({ ...task, status: 'running' })) });
  try {
    await act(async () => { view.container.querySelector('[aria-label="终止任务 s-2"]').click(); });
    const terminations = globalThis.__calls.filter(call => call.path === '/agent/bash-sessions/terminate');
    assert.deepEqual(terminations.map(call => call.body), [{ sessionId: 's-2', workspaceHash: 'hash 1' }]);
    assert.equal(view.container.querySelector('.bash-row.selected strong').textContent, 'pnpm build');
  } finally { await view.close(); }
});

test('the floating entry stays hidden without tasks and a new task does not open the popup', async () => {
  const view = await mount({ floating: true, initialSessions: [] });
  try {
    assert.equal(view.container.querySelector('.background-tasks-trigger'), null);
    assert.equal(view.container.querySelector('.composer-task-anchor').classList.contains('has-tasks'), false);
    view.updateSessions(sessions);
    await act(async () => { window.dispatchEvent(new window.CustomEvent('loopra:bash-start')); });
    assert.equal(view.container.querySelector('.background-tasks-trigger').textContent, '后台');
    assert.equal(view.container.querySelector('[role="dialog"]'), null);
    await act(async () => { view.container.querySelector('.background-tasks-trigger').click(); });
    assert.match(view.container.querySelector('[role="dialog"]').textContent, /pnpm build/);
    assert.doesNotMatch(view.container.querySelector('[role="dialog"]').textContent, /build ok/);
    assert.equal(view.container.querySelector('.background-tasks-unread'), null);
    await act(async () => { view.container.querySelector('[title="查看任务输出"]').click(); });
    assert.equal(view.container.querySelector('.background-tasks-popover'), null);
    assert.match(view.container.querySelector('[aria-label="后台任务输出"]').textContent, /build ok/);
  } finally { await view.close(); }
});

test('opening and reopening use cached tasks and logs without waiting for any network request', async () => {
  const view = await mount({ floating: true });
  try {
    view.holdRequests();
    const callsBeforeOpen = globalThis.__calls.length;
    const trigger = view.container.querySelector('.background-tasks-trigger');
    await act(async () => { trigger.click(); });
    assert.match(view.container.querySelector('.background-tasks-popover').textContent, /pnpm build/);
    assert.doesNotMatch(view.container.textContent, /暂无后台命令|正在读取后台任务/);
    await act(async () => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await act(async () => { trigger.click(); });
    assert.match(view.container.querySelector('.background-tasks-popover').textContent, /pnpm build/);
    await act(async () => { view.container.querySelector('[title="查看任务输出"]').click(); });
    assert.match(view.container.querySelector('[aria-label="任务输出日志"]').textContent, /build ok/);
    assert.equal(globalThis.__calls.length, callsBeforeOpen, 'opening surfaces should not fetch or reset cached state');
    await act(async () => { [...view.container.querySelectorAll('button')].find(button => button.textContent === '关闭').click(); });
    await act(async () => { trigger.click(); });
    await act(async () => { view.container.querySelector('[title="查看任务输出"]').click(); });
    assert.match(view.container.querySelector('[aria-label="任务输出日志"]').textContent, /build ok/);
  } finally { await view.close(); }
});

test('the popup closes with Escape or an outside click and restores focus after Escape', async () => {
  const view = await mount({ floating: true });
  try {
    const trigger = view.container.querySelector('.background-tasks-trigger');
    await act(async () => { trigger.click(); });
    assert.ok(view.container.querySelector('[role="dialog"]'));
    await act(async () => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.equal(view.container.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, trigger);
    await act(async () => { trigger.click(); });
    await act(async () => { view.container.querySelector('textarea').dispatchEvent(new window.Event('pointerdown', { bubbles: true })); });
    assert.equal(view.container.querySelector('[role="dialog"]'), null);
  } finally { await view.close(); }
});

test('clearing all background tasks hides the entry again', async () => {
  const view = await mount({ floating: true });
  try {
    assert.ok(view.container.querySelector('.background-tasks-trigger'));
    await act(async () => { view.container.querySelector('.background-tasks-trigger').click(); });
    view.updateSessions([]);
    await act(async () => { view.container.querySelector('[aria-label="刷新终端"]').click(); });
    assert.equal(view.container.querySelector('.background-tasks-trigger'), null);
    assert.equal(view.container.textContent.match(/暂无后台命令/g)?.length, 1);
    assert.equal(view.container.querySelector('.terminal-output'), null);
  } finally { await view.close(); }
});
