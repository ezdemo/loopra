import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// Legacy TitleBar.vue supplied the frameless Electron window chrome. The React
// renderer needs its own bridge detection + drag region + window controls, and
// the default Electron workspace entry (src/entry-routing.js).
const shellSource = await readFile(new URL('../src/desktop-shell.ts', import.meta.url), 'utf8');
const shellJs = ts.transpileModule(shellSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const shellUrl = 'data:text/javascript;base64,' + Buffer.from(shellJs).toString('base64');
const { desktopPlatform, desktopWindowApi, isDesktopWindow, usesNativeWindowControls } = await import(shellUrl);

const titleBar = await readFile(new URL('../src/components/DesktopTitleBar.tsx', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const routing = await import('../../src/entry-routing.js');

function withWindow(value, run) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const previous = globalThis.window;
  if (value === undefined) delete globalThis.window; else globalThis.window = value;
  try { return run(); } finally { if (had) globalThis.window = previous; else delete globalThis.window; }
}

test('desktop window chrome is detected only when the preload bridge exposes controls', () => {
  assert.equal(withWindow(undefined, () => isDesktopWindow()), false);
  assert.equal(withWindow({ electronAPI: { isElectron: true } }, () => isDesktopWindow()), false);
  assert.equal(withWindow({ electronAPI: { isElectron: true, window: {} } }, () => isDesktopWindow()), false);
  const controls = { minimize: () => {}, maximize: () => {}, close: () => {}, isMaximized: () => true };
  assert.equal(withWindow({ electronAPI: { platform: 'win32', window: controls } }, () => isDesktopWindow()), true);
  assert.equal(withWindow({ electronAPI: { platform: 'win32', window: controls } }, () => desktopWindowApi().close === controls.close), true);
});

test('platform defaults to win32 and only macOS uses native window controls', () => {
  assert.equal(withWindow(undefined, () => desktopPlatform()), 'win32');
  assert.equal(withWindow({ electronAPI: { platform: 'darwin' } }, () => desktopPlatform()), 'darwin');
  assert.equal(usesNativeWindowControls('darwin'), true);
  assert.equal(usesNativeWindowControls('win32'), false);
  assert.equal(usesNativeWindowControls('linux'), false);
});

test('the app renders the title bar and shell class only on desktop', () => {
  assert.match(app, /import DesktopTitleBar from '\.\/components\/DesktopTitleBar';/);
  assert.match(app, /isDesktopWindow\(\) \? ' is-desktop-shell' : ''/);
  assert.match(app, /\{isDesktopWindow\(\) && <DesktopTitleBar \/>\}/);
});

test('the desktop title bar provides a draggable region with no-drag controls', () => {
  assert.match(styles, /\.desktop-titlebar \{[^}]*-webkit-app-region: drag;/);
  assert.match(styles, /\.desktop-window-controls \{[^}]*-webkit-app-region: no-drag;/);
  // The OS draws the macOS traffic lights at a fixed device-pixel position, so
  // the metrics that line up with them must not follow the rem-based UI scale
  // (`:root { font-size: calc(16px * var(--ui-scale)) }`) or they drift onto the
  // title whenever 界面缩放 is below 100%.
  const nativeMetrics = styles.match(/\.desktop-titlebar\.is-native-controls \{([^}]*)\}/)[1];
  assert.match(nativeMetrics, /height: 36px;/);
  assert.match(nativeMetrics, /padding-left: 80px;/);
  assert.doesNotMatch(nativeMetrics, /rem/);
});

test('entry routing uses React by default in Electron and preserves auxiliary windows', () => {
  assert.equal(routing.usesLegacyRenderer('?desktopShell=1', true), false);
  assert.equal(routing.usesLegacyRenderer('', true), false);
  assert.equal(routing.usesLegacyRenderer('?desktopShell=1&react=1', true), false);
  assert.equal(routing.usesLegacyRenderer('?react=1', true), false);
  assert.equal(routing.usesLegacyRenderer('', false), false);
  // Auxiliary Electron windows ignore the opt-in and stay on Vue.
  assert.equal(routing.usesLegacyRenderer('?desktopPet=1&react=1', true), true);
  assert.equal(routing.usesLegacyRenderer('?desktopSplash=1&react=1', true), true);
});

// Mount the real component under jsdom to prove it renders nothing without a
// bridge and wires the three window controls when the bridge exists.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
const previousGlobals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
const previousWindow = globalThis.window;
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
globalThis.window = dom.window;
after(() => {
  dom.window.close();
  for (const [key, descriptor] of previousGlobals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  if (hadWindow) globalThis.window = previousWindow; else delete globalThis.window;
});

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
let viewText = ts.transpileModule(titleBar, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
for (const [specifier, url] of Object.entries({ react: import.meta.resolve('react'), 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), 'react-dom': import.meta.resolve('react-dom'), 'lucide-react': import.meta.resolve('lucide-react'), '../desktop-shell': shellUrl })) {
  viewText = viewText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
}
const { default: DesktopTitleBar } = await import(dataUrl(viewText));

async function render() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(DesktopTitleBar)));
  const html = container.innerHTML;
  await act(async () => root.unmount());
  container.remove();
  return html;
}

test('the title bar is inert in the browser', async () => {
  delete dom.window.electronAPI;
  assert.equal(await render(), '');
});

test('the title bar renders the frameless window controls under Electron', async () => {
  dom.window.electronAPI = { platform: 'win32', window: { minimize: () => {}, maximize: () => {}, close: () => {}, isMaximized: () => true } };
  const html = await render();
  assert.match(html, /class="desktop-titlebar"/);
  assert.match(html, /aria-label="最小化窗口"/);
  assert.match(html, /aria-label="还原窗口"/); // isMaximized() reported true
  assert.match(html, /aria-label="关闭窗口"/);
  assert.match(html, /class="desktop-window-controls"/);
});

test('macOS keeps the native traffic lights and draws no duplicate controls', async () => {
  dom.window.electronAPI = { platform: 'darwin', window: { minimize: () => {}, maximize: () => {}, close: () => {}, isMaximized: () => true } };
  const html = await render();
  assert.match(html, /class="desktop-titlebar is-native-controls"/);
  assert.doesNotMatch(html, /desktop-window-controls/);
  assert.doesNotMatch(html, /aria-label="关闭窗口"/);
  // The shell header directly below already shows the app name, so the drag
  // strip carries no label of its own.
  assert.doesNotMatch(html, /Loopra/);
});
