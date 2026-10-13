import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// The terminal panel mirrors the legacy BashSessionManager: list background
// commands, copy the command/workdir, read a log and stop a running process.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
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
const iconsStub = dataUrl('export const Maximize=()=>null;export const RefreshCw=()=>null;export const SquareTerminal=()=>null;export const X=()=>null;');
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
const panelResizeStub = dataUrl('export const DEFAULT_PANEL_WIDTH = 452; export const WIDE_PANEL_WIDTH = 560; export const resizePanelWidth = width => width;');
const libStub = dataUrl(`
const React = await import(${JSON.stringify(reactUrl)});
export function useLocalState(_key, initial) { return React.useState(initial); }
`);
const bashUrl = await sourceUrl('bash-sessions.ts');
const { TerminalPanel } = await import(await sourceUrl('components/Panels.tsx', {
  '@nextui-org/react': nextuiStub, 'lucide-react': iconsStub, './ui': uiStub, './RemoteControls': controlsStub,
  './FilesPanel': stubPanel, './GitTools': stubPanel, './SchedulePanel': stubPanel, './SubAgentsPanel': stubPanel,
  './ProjectCapabilities': stubPanel, './DiffView': stubPanel, '../bash-sessions': bashUrl, '../lib': libStub, '../panel-resize': panelResizeStub,
}));

const sessions = [
  { sessionId: 's-1', workspace: 'C:/code/loopra', command: 'pnpm build', workdir: 'C:/code/loopra/loopra-front', startedAt: Date.now() - 90_000, status: 'running' },
  { sessionId: 's-2', workspace: 'C:/code/loopra', command: 'sleep 1', workdir: 'C:/code/loopra', startedAt: Date.now() - 900_000, status: 'completed' },
];

async function mount() {
  globalThis.__calls = []; globalThis.__notify = []; globalThis.__copied = [];
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText: async text => { globalThis.__copied.push(text); } } });
  const api = {
    request: (path, method = 'GET', body) => {
      globalThis.__calls.push({ path, method, body });
      if (path.startsWith('/agent/bash-sessions/log')) return Promise.resolve({ output: 'build ok' });
      return Promise.resolve(sessions);
    },
  };
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(TerminalPanel, { api, workspaceHash: 'hash 1', onClose: () => {}, notify: message => globalThis.__notify.push(message) })));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return { container, root, async close() { await act(async () => root.unmount()); container.remove(); } };
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

test('clicking the command and workdir copies them and confirms', async () => {
  const view = await mount();
  try {
    await act(async () => { view.container.querySelector('button[title="点击复制命令"]').click(); await Promise.resolve(); });
    await act(async () => { view.container.querySelector('button[title="点击复制工作目录"]').click(); await Promise.resolve(); });
    assert.deepEqual(globalThis.__copied, ['pnpm build', 'C:/code/loopra/loopra-front']);
    assert.deepEqual(globalThis.__notify, ['复制成功', '复制成功']);
  } finally { await view.close(); }
});

test('stopping a process posts the session id for the active workspace', async () => {
  const view = await mount();
  try {
    await act(async () => { [...view.container.querySelectorAll('button')].find(node => node.textContent === '停止进程').click(); await Promise.resolve(); });
    assert.ok(globalThis.__calls.some(call => call.method === 'POST' && call.path === '/agent/bash-sessions/terminate' && JSON.stringify(call.body) === JSON.stringify({ sessionId: 's-1', workspaceHash: 'hash 1' })));
  } finally { await view.close(); }
});
