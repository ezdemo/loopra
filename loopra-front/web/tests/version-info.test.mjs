import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// Settings → 关于 used to be a placeholder; assert the About page reads the real
// /version endpoints and wires the update commands / auto-update callback.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, HTMLSelectElement: dom.window.HTMLSelectElement, IS_REACT_ACT_ENVIRONMENT: true };
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
export const Button = ({ children, onPress, isLoading, startContent, ...rest }) => createElement('button', { type: 'button', disabled: !!isLoading, onClick: onPress, ...rest }, startContent, children);
`);
const iconsStub = dataUrl('export const ArrowUpRight=()=>null;export const Download=()=>null;export const RefreshCw=()=>null;export const Server=()=>null;export const Sparkles=()=>null;');
const controlsStub = dataUrl(`export const errorText = cause => cause instanceof Error ? cause.message : String(cause);`);
const settingControlsStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const PageActions = ({ title, children }) => createElement('header', null, createElement('h2', null, title), children);
export const SettingRow = ({ title, description, children }) => createElement('div', { className: 'row' }, createElement('span', { className: 'row-title' }, title), description ? createElement('small', null, description) : null, children);
export const SelectField = ({ label, value, onChange, options }) => createElement('select', { 'aria-label': label, value, onChange: event => onChange(event.target.value) },
  options.map(option => { const item = typeof option === 'string' ? { value: option, label: option } : option; return createElement('option', { key: item.value, value: item.value }, item.label); }));
`);
const updateScriptsUrl = await sourceUrl('update-scripts.ts');
const VersionInfo = (await import(await sourceUrl('components/VersionInfo.tsx', {
  '@nextui-org/react': nextuiStub,
  'lucide-react': iconsStub,
  './RemoteControls': controlsStub,
  './SettingControls': settingControlsStub,
  '../update-scripts': updateScriptsUrl,
}))).default;

async function mount() {
  globalThis.__calls = []; globalThis.__notify = []; globalThis.__auto = 0; globalThis.__copied = null;
  dom.window.localStorage.clear();
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText: async text => { globalThis.__copied = text; } } });
  const api = {
    base: 'http://127.0.0.1:4567',
    request: (path, method = 'GET') => {
      globalThis.__calls.push({ path, method });
      if (path === '/version/') return Promise.resolve({ version: '26.9.91', name: 'Loopra' });
      if (path === '/version/check') return Promise.resolve({ currentVersion: '26.9.91', latestVersion: '26.10.1', hasNewVersion: true, releaseUrl: 'https://github.com/ezdemo/loopra-release/releases/tag/v26.10.1', checkTime: '2026-10-13 09:00:00' });
      return Promise.resolve(null);
    },
  };
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(VersionInfo, { api, notify: message => globalThis.__notify.push(message), onAutoUpdate: () => { globalThis.__auto++; } })));
  return { container, root, async close() { await act(async () => root.unmount()); container.remove(); } };
}
const buttonIn = (element, text) => [...element.querySelectorAll('button')].find(candidate => candidate.textContent.includes(text));
async function click(element) { await act(async () => { element.click(); await Promise.resolve(); await Promise.resolve(); }); }

test('reads the current version on mount', async () => {
  const view = await mount();
  try {
    assert.deepEqual(globalThis.__calls[0], { path: '/version/', method: 'GET' });
    assert.ok(view.container.textContent.includes('v26.9.91'));
    assert.match(view.container.querySelector('.row').textContent, /未检查/);
  } finally { await view.close(); }
});

test('checking reports the new version and links the release page', async () => {
  const view = await mount();
  try {
    await click(buttonIn(view.container, '检查更新'));
    assert.ok(globalThis.__calls.some(call => call.path === '/version/check'));
    assert.ok(view.container.textContent.includes('v26.10.1'));
    assert.ok(view.container.textContent.includes('新版'));
    assert.equal(view.container.querySelector('.version-link').getAttribute('href'), 'https://github.com/ezdemo/loopra-release/releases/tag/v26.10.1');
    assert.deepEqual(globalThis.__notify, ['发现新版本 v26.10.1']);
  } finally { await view.close(); }
});

test('copies the update command and switches the download source', async () => {
  const view = await mount();
  try {
    await click(view.container.querySelectorAll('.version-command')[0]);
    assert.match(globalThis.__copied, /setup\.ps1 \| iex$/);
    assert.deepEqual(globalThis.__notify, ['已复制到剪贴板']);
    const select = view.container.querySelector('select[aria-label="更新源"]');
    await act(async () => { select.value = 'https://gh-proxy.org/'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
    assert.match(view.container.querySelectorAll('.version-command')[0].textContent, /setup-mirror\.ps1/);
    assert.equal(dom.window.localStorage.getItem('loopra.updateSource'), 'https://gh-proxy.org/');
  } finally { await view.close(); }
});

test('the auto-update button calls back into the app', async () => {
  const view = await mount();
  try {
    await click(buttonIn(view.container, '更新核心服务'));
    assert.equal(globalThis.__auto, 1);
  } finally { await view.close(); }
});
