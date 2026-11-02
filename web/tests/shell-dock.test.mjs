import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
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
const reactUrl = import.meta.resolve('react');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
async function sourceUrl(name, dependencies) {
  const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
  for (const [specifier, url] of Object.entries({ react: reactUrl, 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), ...dependencies })) {
    outputText = outputText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
  }
  return dataUrl(outputText);
}
const motionUrl = await sourceUrl('components/Motion.tsx', {
  '@nextui-org/react': dataUrl('export const NextUIProvider = ({ children }) => children;'),
  'framer-motion': dataUrl('export const MotionGlobalConfig = {};'),
});
const shellUrl = await sourceUrl('components/ShellDock.tsx', {
  './Motion': motionUrl,
  'lucide-react': import.meta.resolve('lucide-react'),
  '../shell-terminal': dataUrl(`const { useRef } = await import(${JSON.stringify(reactUrl)}); export function useShellTerminal() { return useRef(null); }`),
});
const { default: ShellDock } = await import(shellUrl);
const session = { id: 'shell-1', title: 'PowerShell', cwd: 'C:\\project' };

async function mount(context) {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const calls = [];
  let open = false;
  const api = {
    base: 'http://localhost',
    async request(path, method = 'GET') {
      calls.push({ path, method });
      return method === 'GET' ? { sessions: [session] } : session;
    },
  };
  const render = () => root.render(createElement(ShellDock, { api, workspaceHash: 'project', open, onClose: () => { open = false; render(); } }));
  await act(async () => render());
  return {
    container, calls,
    async show() { await act(async () => { open = true; render(); }); },
    async advance(milliseconds) { await act(async () => context.mock.timers.tick(milliseconds)); },
    async close() { await act(async () => root.unmount()); container.remove(); },
  };
}

test('hiding keeps the terminal through its exit animation and never deletes a session', async context => {
  const view = await mount(context);
  try {
    assert.equal(view.container.querySelector('.shell-dock'), null);
    await view.show();
    const panel = view.container.querySelector('.shell-dock');
    assert.equal(panel.dataset.open, 'true');
    assert.equal(view.container.querySelector('[role="tab"]').textContent, '终端 1');
    const hide = view.container.querySelector('[aria-label="隐藏终端"]');
    assert.ok(hide.querySelector('.lucide-chevron-down'));
    await act(async () => hide.click());
    assert.equal(view.container.querySelector('.shell-dock'), panel);
    assert.equal(panel.dataset.open, 'false');
    assert.equal(panel.getAttribute('aria-hidden'), 'true');
    assert.ok(panel.hasAttribute('inert'));
    await view.advance(299);
    assert.equal(view.container.querySelector('.shell-dock'), panel);
    await view.advance(1);
    assert.equal(view.container.querySelector('.shell-dock'), null);
    await view.show();
    assert.equal(view.container.querySelector('[role="tab"]').title, 'PowerShell');
    assert.equal(view.calls.filter(call => call.method !== 'GET').length, 0);
  } finally { await view.close(); }
});

test('reopening during the exit cancels unmount and preserves the current terminal surface', async context => {
  const view = await mount(context);
  try {
    await view.show();
    const screen = view.container.querySelector('.shell-dock-screen');
    await act(async () => view.container.querySelector('[aria-label="隐藏终端"]').click());
    await view.advance(150);
    await view.show();
    await view.advance(300);
    assert.equal(view.container.querySelector('.shell-dock-screen'), screen);
    assert.equal(view.container.querySelector('.shell-dock').dataset.open, 'true');
    assert.equal(view.container.querySelector('.shell-dock').hasAttribute('inert'), false);
  } finally { await view.close(); }
});

test('the tab close button still deletes its session', async context => {
  const view = await mount(context);
  try {
    await view.show();
    await act(async () => view.container.querySelector('[aria-label="关闭终端 1"]').click());
    assert.deepEqual(view.calls.filter(call => call.method === 'DELETE'), [
      { path: '/shell-terminal/sessions/shell-1?workspaceHash=project', method: 'DELETE' },
    ]);
    assert.equal(view.container.querySelector('.shell-dock').dataset.open, 'false');
    await view.advance(300);
    assert.equal(view.container.querySelector('.shell-dock'), null);
  } finally { await view.close(); }
});
