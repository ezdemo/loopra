import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const sockets = [];
class Socket {
  static OPEN = 1;
  closed = false;
  constructor(url) { this.url = url; sockets.push(this); }
  close() { this.closed = true; }
}
const globals = {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  MutationObserver: dom.window.MutationObserver, ResizeObserver: class { observe() {} disconnect() {} },
  WebSocket: Socket, IS_REACT_ACT_ENVIRONMENT: true,
};
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
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
async function sourceUrl(name, dependencies = {}) {
  const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  for (const [specifier, url] of Object.entries({ react: import.meta.resolve('react'), ...dependencies })) {
    outputText = outputText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
  }
  return dataUrl(outputText);
}
const xtermUrl = dataUrl(`
export const terminals = [];
export class Terminal {
  disposed = false;
  constructor(options) { this.options = options; terminals.push(this); }
  loadAddon() {}
  open() {}
  onData() { return { dispose() {} }; }
  dispose() { this.disposed = true; }
}
`);
const { terminals } = await import(xtermUrl);
const themeUrl = await sourceUrl('document-theme.ts');
const { useShellTerminal, shellTerminalTheme } = await import(await sourceUrl('shell-terminal.ts', {
  '@xterm/xterm': xtermUrl,
  '@xterm/addon-fit': dataUrl('export class FitAddon {}'),
  '@xterm/xterm/css/xterm.css': dataUrl(''),
  './access-key.js': dataUrl('export const getAccessHeaders = async () => ({});'),
  './document-theme': themeUrl,
}));

function TerminalHost() {
  const ref = useShellTerminal('http://localhost', 'project', 'shell-1', true);
  return createElement('div', { ref });
}

test('terminal follows light and dark appearance without replacing the terminal or connection', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(TerminalHost)));
    const terminal = terminals.at(-1);
    const socket = sockets.at(-1);
    const terminalCount = terminals.length;
    const socketCount = sockets.length;
    assert.equal(terminal.options.theme.background, '#ffffff');
    assert.equal(terminal.options.minimumContrastRatio, 4.5);
    await act(async () => document.documentElement.classList.add('dark'));
    assert.equal(terminal.options.theme.background, '#191919');
    assert.equal(terminal.options.theme.cursor, '#ececea');
    await act(async () => document.documentElement.classList.remove('dark'));
    assert.equal(terminal.options.theme.background, '#ffffff');
    assert.equal(terminal.options.theme.cursor, '#1c1c1a');
    assert.equal(terminals.length, terminalCount);
    assert.equal(sockets.length, socketCount);
    assert.equal(socket.closed, false);
    assert.equal(terminal.disposed, false);
    await act(async () => root.unmount());
    assert.equal(socket.closed, true);
    assert.equal(terminal.disposed, true);
    await act(async () => document.documentElement.classList.add('dark'));
    assert.equal(terminal.options.theme.background, '#ffffff', 'unmounted terminals stop observing theme changes');
  } finally {
    await act(async () => root.unmount());
    document.documentElement.classList.remove('dark');
    container.remove();
  }
});

test('both themes provide text, cursor, selections and all sixteen ANSI colors', () => {
  const ansi = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
  for (const dark of [false, true]) {
    const theme = shellTerminalTheme(dark);
    for (const color of [...ansi, ...ansi.map(name => `bright${name[0].toUpperCase()}${name.slice(1)}`), 'background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground', 'selectionInactiveBackground']) {
      assert.match(theme[color], /^#[0-9a-f]{6}$/i, `missing ${dark ? 'dark' : 'light'} ${color}`);
    }
    assert.notEqual(theme.background, theme.foreground);
    assert.notEqual(theme.cursor, theme.cursorAccent);
  }
});
