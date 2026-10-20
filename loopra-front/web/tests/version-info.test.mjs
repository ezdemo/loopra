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
export const Button = ({ children, onPress, isLoading, isDisabled, startContent, ...rest }) => createElement('button', { type: 'button', disabled: !!isLoading || !!isDisabled, onClick: onPress, ...rest }, startContent, children);
export const Modal = ({ isOpen, children, onClose, classNames, placement, scrollBehavior, ...rest }) => isOpen ? createElement('section', { role: 'dialog', ...rest }, children) : null;
export const ModalContent = ({ children }) => createElement('div', null, children);
export const ModalHeader = ({ children }) => createElement('header', null, children);
export const ModalBody = ({ children }) => createElement('div', null, children);
export const ModalFooter = ({ children }) => createElement('footer', null, children);
`);
const iconsStub = dataUrl('export const ArrowUpRight=()=>null;export const Download=()=>null;export const RefreshCw=()=>null;export const Server=()=>null;export const Square=()=>null;');
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

async function mount(initialCheck) {
  globalThis.__calls = []; globalThis.__notify = []; globalThis.__copied = null;
  const idle = { running: false, state: 'idle', platform: '', target: '', logFile: '', log: '', message: '暂无更新任务' };
  const running = {
    running: true, state: 'running', platform: 'Windows', target: '桌面端核心服务',
    logFile: '/tmp/loopra-update.log', log: '[Loopra] 正在下载并安装新版本',
    message: '核心服务更新中',
  };
  const stopped = { ...running, running: false, state: 'stopped', log: '[Loopra] 更新已停止', message: '更新已停止' };
  let updateState = idle;
  dom.window.localStorage.clear();
  Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: { writeText: async text => { globalThis.__copied = text; } } });
  const api = {
    base: 'http://127.0.0.1:4567',
    request: (path, method = 'GET', body) => {
      const call = { path, method };
      if (body !== undefined) call.body = body;
      globalThis.__calls.push(call);
      if (path === '/version/') return Promise.resolve({ version: '26.9.91', name: 'Loopra' });
      if (path === '/version/check') return Promise.resolve({ currentVersion: '26.9.91', latestVersion: '26.10.1', hasNewVersion: true, releaseUrl: 'https://github.com/ezdemo/loopra-release/releases/tag/v26.10.1', checkTime: '2026-10-13 09:00:00' });
      if (path === '/version/update' && method === 'GET') return Promise.resolve(updateState);
      if (path === '/version/update' && method === 'POST') { updateState = running; return Promise.resolve(running); }
      if (path === '/version/update/stop') { updateState = stopped; return Promise.resolve(stopped); }
      return Promise.resolve(null);
    },
  };
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(VersionInfo, { api, initialCheck, notify: message => globalThis.__notify.push(message) })));
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

test('shows the startup update result before another manual check', async () => {
  const view = await mount({
    currentVersion: '26.9.91',
    latestVersion: '26.10.1',
    hasNewVersion: true,
    releaseUrl: 'https://github.com/ezdemo/loopra-release/releases/tag/v26.10.1',
  });
  try {
    assert.ok(view.container.textContent.includes('v26.10.1'));
    assert.ok(view.container.textContent.includes('新版'));
    assert.ok(!globalThis.__calls.some(call => call.path === '/version/check'));
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

test('the update button asks the Java service to update without creating an agent session', async () => {
  const view = await mount();
  try {
    await click(buttonIn(view.container, '更新核心服务'));
    const request = globalThis.__calls.find(call => call.path === '/version/update' && call.method === 'POST');
    assert.deepEqual(request, { path: '/version/update', method: 'POST', body: { source: 'normal' } });
    assert.ok(buttonIn(view.container, '查看更新进度'));
    assert.equal(view.container.querySelector('[role="dialog"]').getAttribute('aria-label'), '核心服务更新日志');
    assert.ok(view.container.textContent.includes('/tmp/loopra-update.log'));
    assert.ok(view.container.textContent.includes('更新日志'));
    assert.ok(view.container.textContent.includes('正在下载并安装新版本'));
    assert.deepEqual(globalThis.__notify, ['核心服务更新中']);

    await click(buttonIn(view.container, '停止更新'));
    assert.ok(globalThis.__calls.some(call => call.path === '/version/update/stop' && call.method === 'POST'));
    assert.ok(!buttonIn(view.container, '停止更新'));
    assert.ok(view.container.textContent.includes('已停止'));
    assert.ok(view.container.textContent.includes('[Loopra] 更新已停止'));
  } finally { await view.close(); }
});
