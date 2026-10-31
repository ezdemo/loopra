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
  for (const [specifier, url] of Object.entries({ react: reactUrl, 'react-dom': import.meta.resolve('react-dom'), 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), ...dependencies })) {
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
const iconsStub = dataUrl('export const Copy=()=>null;export const Maximize=()=>null;export const RefreshCw=()=>null;export const SquareTerminal=()=>null;export const X=()=>null;export const Bot=()=>null;export const CalendarClock=()=>null;export const Check=()=>null;export const ChevronDown=()=>null;export const FolderTree=()=>null;export const GitBranch=()=>null;export const Puzzle=()=>null;export const Waypoints=()=>null;');
const motionStub = dataUrl('export const Popup = () => null;');
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
const environmentPanelStub = dataUrl('export default () => null; export const EnvironmentBar = () => null; export const useEnvironmentController = () => ({ mode: undefined });');
const workspaceEventsStub = dataUrl('export const watchWorkspaceChanges = () => () => {};');
const panelResizeStub = await sourceUrl('panel-resize.ts');
const libStub = dataUrl(`
const React = await import(${JSON.stringify(reactUrl)});
export function useLocalState(_key, initial) { return React.useState(initial); }
`);
const bashUrl = await sourceUrl('bash-sessions.ts');
const bashStateUrl = await sourceUrl('useBashSessions.ts', { './bash-sessions': bashUrl });
const panelsUrl = await sourceUrl('components/Panels.tsx', {
  './PluginFrame': dataUrl(`const {createElement} = await import(${JSON.stringify(reactUrl)}); export const PluginFrame = props => createElement('div', { 'data-plugin': props.id, 'data-slot': props.slot, 'data-session': props.context?.sessionId }, props.name);`),
  './plugin-icons': dataUrl('export const PluginGlyph = () => null;'),
  '@nextui-org/react': nextuiStub, 'lucide-react': iconsStub, './ui': uiStub, './Motion': motionStub, './RemoteControls': controlsStub,
  './FilesPanel': stubPanel, './GitTools': stubPanel, './SchedulePanel': stubPanel, './SubAgentsPanel': stubPanel,
  './ProjectCapabilities': dataUrl(`import {createElement} from ${JSON.stringify(reactUrl)}; export default ({workspaceHash}) => createElement('div', {'data-capabilities':workspaceHash});`), './EnvironmentPanel': environmentPanelStub, './DiffView': stubPanel, '../bash-sessions': bashUrl, '../lib': libStub, '../panel-resize': panelResizeStub, '../useBashSessions': bashStateUrl, '../workspace-events': workspaceEventsStub,
});
const { TerminalPanel, default: ChangesPanel } = await import(panelsUrl);

const taskLogUrl = await sourceUrl('components/BackgroundTaskLog.tsx', { '@nextui-org/react': nextuiStub, '../bash-sessions': bashUrl });
const { default: BackgroundTasks } = await import(await sourceUrl('components/BackgroundTasks.tsx', {
  'lucide-react': iconsStub, './Panels': panelsUrl, '../useBashSessions': bashStateUrl, './BackgroundTaskLog': taskLogUrl,
}));

const sessions = [
  { sessionId: 's-1', workspace: 'C:/code/loopra', command: 'pnpm build', workdir: 'C:/code/loopra/loopra-front', startedAt: Date.now() - 90_000, status: 'running' },
  { sessionId: 's-2', workspace: 'C:/code/loopra', command: 'sleep 1', workdir: 'C:/code/loopra', startedAt: Date.now() - 900_000, status: 'completed' },
];

async function mount({ floating = false, initialSessions = sessions, actions, toolbarTarget } = {}) {
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
    return createElement(BackgroundTasks, { api, workspaceHash: 'hash 1', connected: true, open, onOpenChange: setOpen, notify: () => {}, actions, toolbarTarget }, createElement('textarea', { 'aria-label': '输入消息' }));
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

test('composer actions share the toolbar after Background and remain available without background tasks', async () => {
  for (const initialSessions of [sessions, []]) {
    const view = await mount({ floating: true, initialSessions, actions: createElement('button', { type: 'button' }, '待办') });
    try {
      assert.deepEqual([...view.container.querySelectorAll('.composer-task-toolbar button')].map(button => button.textContent), initialSessions.length ? ['后台', '待办'] : ['待办']);
      assert.ok(view.container.querySelector('textarea'));
    } finally { await view.close(); }
  }
});

test('a toolbar mounted beside the Agent still opens the task panel and restores focus', async () => {
  const slot = document.createElement('div'); document.body.append(slot);
  const view = await mount({ floating: true, toolbarTarget: slot });
  try {
    assert.equal(view.container.querySelector('.background-tasks-trigger'), null);
    const trigger = slot.querySelector('.background-tasks-trigger');
    assert.ok(trigger);
    await act(async () => trigger.click());
    assert.ok(view.container.querySelector('[role="dialog"]'));
    await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.equal(view.container.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, trigger);
  } finally { await view.close(); slot.remove(); }
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

test('pure chat shows capabilities and plugin panels while hiding file and Git tabs', async () => {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const props = { open: true, api: {}, workspaceHash: '__loopra_chat__', onClose() {}, notify() {}, onOpenFile() {}, sessions: [], onAdd() {}, context: {sessionId:'chat/one'}, plugins: [{ id: 'lens', title: '透镜' }] };
  try {
    for (const initialTab of ['files', 'git', 'capabilities']) {
      await act(async () => root.render(createElement(ChangesPanel, { ...props, chatMode: true, initialTab })));
      assert.deepEqual([...container.querySelectorAll('[role="tab"]')].map(tab => tab.textContent), ['能力', '透镜']);
      assert.equal(container.querySelector('.workbench-body').dataset.tab, 'capabilities');
      assert.equal(container.querySelector('[data-capabilities]').dataset.capabilities, '__loopra_chat__');
      assert.equal(container.querySelector('[data-plugin]'), null);
    }
    await act(async () => container.querySelectorAll('[role="tab"]')[1].click());
    assert.equal(container.querySelector('[data-plugin]').dataset.session, 'chat/one');
    assert.equal(container.querySelector('[data-plugin]').dataset.slot, 'panel');
    await act(async () => root.render(createElement(ChangesPanel, { ...props, chatMode: true, initialTab: 'plugin:lens' })));
    assert.equal(container.querySelector('.workbench-body').dataset.tab, 'plugin:lens');
    await act(async () => root.render(createElement(ChangesPanel, { ...props, plugins: [], chatMode: true, initialTab: 'plugin:lens' })));
    assert.equal(container.querySelector('[data-plugin]'), null);
    assert.equal(container.querySelector('.workbench-body').dataset.tab, 'capabilities');
    await act(async () => root.render(createElement(ChangesPanel, { ...props, chatMode: false, workspaceHash: 'project', initialTab: 'files' })));
    assert.deepEqual([...container.querySelectorAll('[role="tab"]')].map(tab => tab.textContent), ['文件', 'Git', '能力', '透镜']);
    assert.equal(container.querySelector('.workbench-body').dataset.tab, 'files');
  } finally { await act(async () => root.unmount()); container.remove(); }
});

test('right-panel plugin tabs share context, refresh and disappear when removed', async () => {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container), selections = [];
  const props = { open: true, api: {}, workspaceHash: 'project', onClose() {}, notify() {}, onOpenFile() {}, sessions: [], onAdd() {}, context: { sessionId: 'project/one' }, initialTab: 'plugin:lens', onTabChange: tab => selections.push(tab) };
  try {
    await act(async () => root.render(createElement(ChangesPanel, { ...props, plugins: [{ id: 'lens', title: '透镜' }] })));
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    assert.deepEqual(tabs.map(tab => tab.textContent), ['文件', 'Git', '能力', '透镜']);
    assert.equal(container.querySelector('[data-plugin]').dataset.slot, 'panel');
    assert.equal(container.querySelector('[data-plugin]').dataset.session, 'project/one');
    await act(async () => tabs[0].click());
    assert.equal(selections.at(-1), 'files');
    await act(async () => root.render(createElement(ChangesPanel, { ...props, plugins: [] })));
    assert.equal(container.querySelector('[data-plugin]'), null);
    assert.equal(container.querySelector('[aria-selected="true"]').textContent, '文件');
  } finally { await act(async () => root.unmount()); container.remove(); }
});

test('right-panel tab reveal scrolls only the tab strip and never the app shell', async () => {
  const shell = document.createElement('div'); shell.className = 'desktop-app'; document.body.append(shell);
  const root = createRoot(shell), prototype = window.HTMLElement.prototype;
  const previousRect = prototype.getBoundingClientRect;
  const previousScroll = Object.getOwnPropertyDescriptor(prototype, 'scrollIntoView');
  let contentLeft = 730;
  prototype.getBoundingClientRect = function() {
    if (this.classList.contains('workbench-tabs')) return new window.DOMRect(500, 0, 120, 30);
    if (this.matches('[role="tab"][aria-selected="true"]')) return new window.DOMRect(contentLeft - shell.querySelector('.workbench-tabs').scrollLeft, 0, 60, 30);
    return previousRect.call(this);
  };
  // Native scrollIntoView also scrolls overflow:hidden ancestors. Reproduce
  // that browser behavior rather than jsdom's otherwise missing implementation.
  Object.defineProperty(prototype, 'scrollIntoView', { configurable: true, value() { shell.scrollLeft = 90; } });
  const props = { open: true, api: {}, workspaceHash: 'project', onClose() {}, notify() {}, onOpenFile() {}, sessions: [], onAdd() {}, plugins: [{ id: 'lens', title: '透镜' }] };
  try {
    await act(async () => root.render(createElement(ChangesPanel, { ...props, initialTab: 'plugin:lens' })));
    const strip = shell.querySelector('.workbench-tabs');
    assert.equal(shell.scrollLeft, 0, 'revealing a right-panel tab must not move the left sidebar');
    assert.equal(strip.scrollLeft, 170, 'a clipped right edge should scroll into the strip');
    contentLeft = 550;
    await act(async () => root.render(createElement(ChangesPanel, { ...props, initialTab: 'files' })));
    assert.equal(strip.scrollLeft, 50, 'a clipped left edge should scroll back inside the strip');
    contentLeft = 580;
    await act(async () => root.render(createElement(ChangesPanel, { ...props, initialTab: 'capabilities' })));
    assert.equal(strip.scrollLeft, 50, 'an already visible tab should not scroll');
    assert.equal(shell.scrollLeft, 0);
  } finally {
    await act(async () => root.unmount()); shell.remove();
    prototype.getBoundingClientRect = previousRect;
    if (previousScroll) Object.defineProperty(prototype, 'scrollIntoView', previousScroll); else delete prototype.scrollIntoView;
  }
});

async function mountResizablePanel() {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const props = { open: true, api: {}, workspaceHash: 'project', onClose() {}, notify() {}, onOpenFile() {}, sessions: [], onAdd() {}, plugins: [{ id: 'lens', title: '透镜' }], initialTab: 'plugin:lens' };
  await act(async () => root.render(createElement(ChangesPanel, props)));
  const handle = container.querySelector('.panel-resize-handle'), panel = container.querySelector('.changes-panel');
  const captured = new Set();
  handle.setPointerCapture = id => captured.add(id);
  handle.hasPointerCapture = id => captured.has(id);
  handle.releasePointerCapture = id => captured.delete(id);
  panel.getBoundingClientRect = () => new window.DOMRect(500, 0, Number.parseFloat(panel.style.width), 800);
  return {
    container, panel, captured,
    async pointer(type, x, id = 1, button = 0) {
      const event = new window.MouseEvent(type, { bubbles: true, clientX: x, button });
      Object.defineProperty(event, 'pointerId', { value: id });
      await act(async () => handle.dispatchEvent(event));
    },
    async hide() { await act(async () => root.render(createElement(ChangesPanel, { ...props, open: false }))); },
    async close() { await act(async () => root.unmount()); container.remove(); },
  };
}

test('panel resizing captures the pointer and shields plugin pages until release', async () => {
  const view = await mountResizablePanel();
  const plugin = view.container.querySelector('[data-plugin]');
  try {
    await view.pointer('pointerdown', 500, 1, 2);
    assert.equal(document.querySelector('.panel-resize-shield'), null, 'right clicks must not start resizing');
    await view.pointer('pointerdown', 500);
    assert.ok(view.captured.has(1));
    assert.equal(document.querySelector('.panel-resize-shield').parentElement, document.body, 'the shield covers every iframe, outside panel clipping');
    await view.pointer('pointermove', 650, 2);
    assert.equal(view.panel.style.width, '452px', 'other pointers cannot change the width');
    await view.pointer('pointerup', 650, 2);
    assert.ok(view.captured.has(1), 'another pointer cannot finish this drag');
    await view.pointer('pointermove', 650);
    assert.equal(view.panel.style.width, '302px', 'moving over the original plugin bounds shrinks the panel continuously');
    await view.pointer('pointermove', 300);
    assert.equal(view.panel.style.width, '652px', 'reversing direction continues from the original grab point');
    assert.equal(view.container.querySelector('[data-plugin]'), plugin, 'resizing preserves the mounted plugin');
    await view.pointer('pointerup', 300);
    assert.equal(view.captured.size, 0);
    assert.equal(document.querySelector('.panel-resize-shield'), null);
    await view.pointer('pointermove', 600);
    assert.equal(view.panel.style.width, '652px', 'moving after release must not keep resizing');
  } finally { await view.close(); }
});

test('interrupted panel drags release capture and never leave a page-blocking shield', async () => {
  for (const end of ['pointercancel', 'lostpointercapture', 'blur', 'hide', 'unmount']) {
    const view = await mountResizablePanel();
    try {
      await view.pointer('pointerdown', 500);
      if (end === 'blur') await act(async () => window.dispatchEvent(new window.Event('blur')));
      else if (end === 'hide') await view.hide();
      else if (end === 'unmount') await view.close();
      else await view.pointer(end, 500);
      assert.equal(view.captured.size, 0, `${end} releases the pointer`);
      assert.equal(document.querySelector('.panel-resize-shield'), null, `${end} restores plugin interaction`);
    } finally { if (end !== 'unmount') await view.close(); }
  }
});
