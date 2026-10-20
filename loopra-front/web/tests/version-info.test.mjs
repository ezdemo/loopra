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
export const Button = ({ children, onPress, isLoading, isDisabled, isIconOnly, startContent, ...rest }) => createElement('button', { type: 'button', disabled: !!isLoading || !!isDisabled, onClick: onPress, ...rest }, startContent, children);
export const Modal = ({ isOpen, children, onClose, classNames, placement, scrollBehavior, hideCloseButton, isDismissable, size, ...rest }) => isOpen ? createElement('section', { role: 'dialog', ...rest }, children) : null;
export const ModalContent = ({ children }) => createElement('div', null, children);
export const ModalHeader = ({ children }) => createElement('header', null, children);
export const ModalBody = ({ children }) => createElement('div', null, children);
export const ModalFooter = ({ children }) => createElement('footer', null, children);
export const Progress = ({ value, ...rest }) => createElement('progress', { value, max: 100, ...rest });
`);
const iconsStub = dataUrl('export const ArrowRight=()=>null;export const ArrowUpRight=()=>null;export const Check=()=>null;export const CircleAlert=()=>null;export const CircleCheck=()=>null;export const CirclePause=()=>null;export const Copy=()=>null;export const Download=()=>null;export const FileText=()=>null;export const LoaderCircle=()=>null;export const RefreshCw=()=>null;export const Server=()=>null;export const Square=()=>null;export const Terminal=()=>null;');
const controlsStub = dataUrl(`export const errorText = cause => cause instanceof Error ? cause.message : String(cause);`);
const settingControlsStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const PageActions = ({ title, children }) => createElement('header', null, createElement('h2', null, title), children);
export const SettingRow = ({ title, description, children }) => createElement('div', { className: 'row' }, createElement('span', { className: 'row-title' }, title), description ? createElement('small', null, description) : null, children);
export const SelectField = ({ label, value, onChange, options, disabled }) => createElement('select', { 'aria-label': label, value, disabled, onChange: event => onChange(event.target.value) },
  options.map(option => { const item = typeof option === 'string' ? { value: option, label: option } : option; return createElement('option', { key: item.value, value: item.value }, item.label); }));
`);
const updateScriptsUrl = await sourceUrl('update-scripts.ts');
const sharedDependencies = {
  '@nextui-org/react': nextuiStub,
  'lucide-react': iconsStub,
  './RemoteControls': controlsStub,
  '../update-scripts': updateScriptsUrl,
  './SettingControls': settingControlsStub,
};
const coreServiceUpdateUrl = await sourceUrl('components/CoreServiceUpdate.tsx', sharedDependencies);
const { CoreServiceUpdateDialog, useCoreServiceUpdate } = await import(coreServiceUpdateUrl);
const { default: VersionInfo, VersionInfoPanel } = await import(await sourceUrl('components/VersionInfo.tsx', {
  ...sharedDependencies,
  './CoreServiceUpdate': coreServiceUpdateUrl,
  './SettingControls': settingControlsStub,
  '../update-scripts': updateScriptsUrl,
}));
const { default: Header } = await import(await sourceUrl('layout/Header.tsx', {
  'lucide-react': import.meta.resolve('lucide-react'),
  '../components/ui': dataUrl(`
    const { createElement } = await import(${JSON.stringify(reactUrl)});
    export const IconButton = ({ label, children, onClick }) => createElement('button', { 'aria-label': label, onClick }, children);
  `),
  '../components/Motion': dataUrl('export const Popup = () => null;'),
}));
const { DesktopUpdateDialog, useDesktopUpdate } = await import(await sourceUrl('components/DesktopUpdate.tsx', {
  ...sharedDependencies,
  '../desktop-shell': await sourceUrl('desktop-shell.ts'),
  '../desktop-update': await sourceUrl('desktop-update.ts'),
}));

async function mount(initialCheck, Component = VersionInfo, scenario = {}) {
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
      if (path === '/version/check') {
        if (scenario.checkError) return Promise.reject(new Error(scenario.checkError));
        return Promise.resolve(scenario.versionCheck || { currentVersion: '26.9.91', latestVersion: '26.10.1', hasNewVersion: true, releaseUrl: 'https://github.com/ezdemo/loopra-release/releases/tag/v26.10.1', checkTime: '2026-10-13 09:00:00' });
      }
      if (path === '/version/update' && method === 'GET') return Promise.resolve(updateState);
      if (path === '/version/update' && method === 'POST') { updateState = running; return Promise.resolve(running); }
      if (path === '/version/update/stop') { updateState = stopped; return Promise.resolve(stopped); }
      return Promise.resolve(null);
    },
  };
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Component, { api, initialCheck, notify: message => globalThis.__notify.push(message) })));
  return { container, root, async close() { await act(async () => root.unmount()); container.remove(); } };
}
const buttonIn = (element, text) => [...element.querySelectorAll('button')].find(candidate => candidate.textContent.includes(text));
async function click(element) { await act(async () => { element.click(); await Promise.resolve(); await Promise.resolve(); }); }

const desktopState = {
  supported: true, currentVersion: '26.10.2001', latestVersion: '26.10.2002',
  status: 'downloading', percent: 48.9, transferred: 48, total: 100, bytesPerSecond: 10,
  error: '', checkedAt: '', revision: 2,
};

test('desktop header shows download progress and a guarded restart without confusing the backend version', async () => {
  let listener; let installs = 0; let unsubscribed = false;
  dom.window.electronAPI = { desktopUpdate: {
    getState: async () => desktopState,
    onState: callback => { listener = callback; return () => { unsubscribed = true; }; },
    install: async () => { installs++; }, check: async () => desktopState,
  } };
  function Host() {
    const [running, setRunning] = useState(true);
    const controller = useDesktopUpdate(running ? '任务正在运行' : '');
    return createElement('div', null,
      createElement(Header, { sidebarOpen: true, isHome: true, menu: null,
        backend: { status: 'connected', ready: true, error: '', version: '26.9.91' },
        latestVersion: '26.99.1', desktopUpdate: controller.state, onVersion: controller.show }),
      createElement('button', { onClick: () => setRunning(false) }, '任务结束'),
      createElement(DesktopUpdateDialog, { controller }));
  }
  const view = await mount(undefined, Host);
  try {
    const header = view.container.querySelector('.app-version');
    assert.equal(header.textContent, '下载中 48%');
    assert.match(header.title, /桌面端 v26\.10\.2001/);
    assert.doesNotMatch(header.title, /26\.99/);
    assert.match(view.container.querySelector('.backend-status').title, /v26\.9\.91/);
    await click(header);
    assert.equal(view.container.querySelector('progress').value, 48.9);
    await act(async () => listener({ ...desktopState, status: 'downloaded', percent: 100, revision: 3 }));
    assert.equal(header.textContent, '重启并安装');
    const install = buttonIn(view.container.querySelector('[role="dialog"]'), '重启并安装');
    assert.equal(install.disabled, true);
    await click(install); assert.equal(installs, 0);
    await click(buttonIn(view.container, '任务结束'));
    assert.equal(install.disabled, false);
    await click(install); assert.equal(installs, 1);
  } finally { await view.close(); delete dom.window.electronAPI; }
  assert.equal(unsubscribed, true);
});

test('a delayed initial desktop state cannot overwrite a newer update event', async () => {
  let listener; let resolveInitial;
  dom.window.electronAPI = { desktopUpdate: {
    getState: () => new Promise(resolve => { resolveInitial = resolve; }),
    onState: callback => { listener = callback; return () => {}; },
  } };
  function Host() {
    const controller = useDesktopUpdate();
    return createElement('span', null, controller.state?.status || 'waiting');
  }
  const view = await mount(undefined, Host);
  try {
    await act(async () => listener({ ...desktopState, status: 'downloaded', revision: 4 }));
    await act(async () => resolveInitial(desktopState));
    assert.equal(view.container.textContent, 'downloaded');
  } finally { await view.close(); delete dom.window.electronAPI; }
});

test('desktop errors remain actionable and retries do not invoke the core update API', async () => {
  let checks = 0;
  dom.window.electronAPI = { desktopUpdate: {
    getState: async () => ({ ...desktopState, status: 'error', error: '网络中断' }),
    onState: () => () => {},
    check: async () => { checks++; throw new Error('请检查网络'); },
  } };
  function Host() {
    const controller = useDesktopUpdate();
    return createElement('div', null, createElement('button', { onClick: controller.show }, '更新'), createElement(DesktopUpdateDialog, { controller }));
  }
  const view = await mount(undefined, Host);
  try {
    await click(buttonIn(view.container, '更新'));
    assert.match(view.container.querySelector('[role="alert"]').textContent, /网络中断/);
    await click(buttonIn(view.container, '重试更新'));
    assert.equal(checks, 1);
    assert.match(view.container.querySelector('[role="alert"]').textContent, /请检查网络/);
    assert.deepEqual(globalThis.__calls, []);
  } finally { await view.close(); delete dom.window.electronAPI; }
});

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
    assert.equal(view.container.querySelector('[role="dialog"]').getAttribute('aria-label'), '核心服务更新');
    assert.ok(view.container.querySelector('[aria-label="版本对比"]').textContent.includes('v26.9.91'));
    assert.ok(view.container.querySelector('[aria-label="版本对比"]').textContent.includes('v26.10.1'));
    assert.ok(!globalThis.__calls.some(call => call.path === '/version/update' && call.method === 'POST'));
    await click(buttonIn(view.container, '开始更新'));
    const request = globalThis.__calls.find(call => call.path === '/version/update' && call.method === 'POST');
    assert.deepEqual(request, { path: '/version/update', method: 'POST', body: { source: 'normal' } });
    assert.ok(buttonIn(view.container, '查看更新进度'));
    assert.equal(view.container.querySelector('[role="dialog"]').getAttribute('aria-label'), '核心服务更新日志');
    assert.ok(view.container.textContent.includes('/tmp/loopra-update.log'));
    assert.ok(view.container.textContent.includes('更新日志'));
    assert.ok(view.container.textContent.includes('正在下载并安装新版本'));
    assert.equal(view.container.querySelector('[role="status"]').dataset.state, 'running');
    assert.equal(view.container.querySelector('.version-update-line-count').textContent, '1 行');
    assert.deepEqual(globalThis.__notify, ['核心服务更新中']);

    await click(buttonIn(view.container, '复制日志'));
    assert.equal(globalThis.__copied, '[Loopra] 正在下载并安装新版本');
    await click(view.container.querySelector('[aria-label="复制日志路径"]'));
    assert.equal(globalThis.__copied, '/tmp/loopra-update.log');

    await click(buttonIn(view.container, '停止更新'));
    assert.ok(globalThis.__calls.some(call => call.path === '/version/update/stop' && call.method === 'POST'));
    assert.ok(!buttonIn(view.container, '停止更新'));
    assert.ok(view.container.textContent.includes('已停止'));
    assert.ok(view.container.textContent.includes('[Loopra] 更新已停止'));
    assert.equal(view.container.querySelector('[role="status"]').dataset.state, 'stopped');
  } finally { await view.close(); }
});

test('opening update progress closes settings without unmounting the update task', async () => {
  function SettingsHost({ api, notify }) {
    const [settingsOpen, setSettingsOpen] = useState(true);
    const controller = useCoreServiceUpdate(api, notify, () => setSettingsOpen(false), settingsOpen);
    return createElement('div', null,
      createElement('button', { onClick: () => setSettingsOpen(true) }, '打开设置'),
      settingsOpen && createElement('section', { 'aria-label': '设置' }, createElement(VersionInfoPanel, { api, notify, coreUpdate: controller })),
      createElement(CoreServiceUpdateDialog, { controller, notify }));
  }
  const view = await mount(undefined, SettingsHost);
  try {
    assert.ok(view.container.querySelector('[aria-label="设置"]'));
    await click(buttonIn(view.container, '更新核心服务'));
    assert.equal(view.container.querySelector('[aria-label="设置"]'), null);
    assert.ok(view.container.querySelector('[aria-label="核心服务更新"]'));
    assert.ok(!globalThis.__calls.some(call => call.path === '/version/update' && call.method === 'POST'));
    await click(buttonIn(view.container, '开始更新'));
    assert.ok(view.container.querySelector('[aria-label="核心服务更新日志"]'));
    assert.equal(view.container.querySelector('[role="status"]').dataset.state, 'running');

    await click(buttonIn(view.container, '关闭'));
    assert.equal(view.container.querySelector('[role="dialog"]'), null);
    assert.equal(view.container.querySelector('[aria-label="设置"]'), null);

    await click(buttonIn(view.container, '打开设置'));
    await click(buttonIn(view.container, '查看更新进度'));
    assert.equal(view.container.querySelector('[aria-label="设置"]'), null);
    assert.ok(view.container.textContent.includes('正在下载并安装新版本'));
    assert.equal(globalThis.__calls.filter(call => call.path === '/version/update' && call.method === 'POST').length, 1);
    await click(buttonIn(view.container, '停止更新'));
    assert.equal(view.container.querySelector('[role="status"]').dataset.state, 'stopped');
  } finally { await view.close(); }
});

test('closing the version preview never starts an update', async () => {
  const view = await mount();
  try {
    await click(buttonIn(view.container, '更新核心服务'));
    await click(buttonIn(view.container.querySelector('[role="dialog"]'), '关闭'));
    assert.equal(view.container.querySelector('[role="dialog"]'), null);
    assert.ok(!globalThis.__calls.some(call => call.path === '/version/update' && call.method === 'POST'));
  } finally { await view.close(); }
});

test('the top bar opens confirmation directly and shares its source and running task with settings', async () => {
  function HeaderHost({ api, notify }) {
    const [settingsOpen, setSettingsOpen] = useState(false);
    const controller = useCoreServiceUpdate(api, notify, () => setSettingsOpen(false), settingsOpen);
    return createElement('div', null,
      createElement(Header, {
        sidebarOpen: true, isHome: true, menu: null,
        backend: { status: 'connected', ready: true, error: '', version: '26.9.91' },
        latestVersion: '26.10.1',
        onVersion: () => controller.update?.running || controller.startingUpdate
          ? controller.show() : controller.prepare('26.9.91'),
      }),
      createElement('button', { onClick: () => setSettingsOpen(true) }, '打开设置'),
      settingsOpen && createElement('section', { 'aria-label': '设置' }, createElement(VersionInfoPanel, { api, notify, coreUpdate: controller })),
      createElement(CoreServiceUpdateDialog, { controller, notify }));
  }
  const view = await mount(undefined, HeaderHost);
  try {
    assert.equal(globalThis.__calls.length, 0);
    assert.equal(view.container.querySelector('.app-version').textContent, '发现新版');
    assert.equal(view.container.querySelector('.app-version-number'), null);
    assert.match(view.container.querySelector('.app-version').title, /v26\.9\.91.*v26\.10\.1/);
    await click(view.container.querySelector('.app-version'));
    let dialog = view.container.querySelector('[aria-label="核心服务更新"]');
    assert.ok(dialog);
    assert.equal(view.container.querySelector('[aria-label="设置"]'), null);
    assert.match(dialog.querySelector('[aria-label="版本对比"]').textContent, /v26\.9\.91.*v26\.10\.1/);
    assert.ok(!globalThis.__calls.some(call => call.method === 'POST'));

    const source = dialog.querySelector('select[aria-label="更新源"]');
    await act(async () => { source.value = 'https://gh-proxy.org/'; source.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
    await click(buttonIn(dialog, '关闭'));
    assert.ok(!globalThis.__calls.some(call => call.method === 'POST'));
    await click(buttonIn(view.container, '打开设置'));
    assert.equal(view.container.querySelector('select[aria-label="更新源"]').value, 'https://gh-proxy.org/');

    await click(view.container.querySelector('.app-version'));
    assert.equal(view.container.querySelector('[aria-label="设置"]'), null);
    dialog = view.container.querySelector('[aria-label="核心服务更新"]');
    assert.equal(dialog.querySelector('select[aria-label="更新源"]').value, 'https://gh-proxy.org/');
    await click(buttonIn(dialog, '开始更新'));
    await click(buttonIn(view.container.querySelector('[role="dialog"]'), '关闭'));
    await click(view.container.querySelector('.app-version'));
    assert.ok(view.container.querySelector('[aria-label="核心服务更新日志"]'));
    assert.match(view.container.textContent, /正在下载并安装新版本/);
    assert.deepEqual(globalThis.__calls.filter(call => call.method === 'POST'), [
      { path: '/version/update', method: 'POST', body: { source: 'https://gh-proxy.org/' } },
    ]);
  } finally { await view.close(); }
});

test('version check failure can be retried before starting the update', async () => {
  const scenario = { checkError: '无法连接版本服务' };
  const view = await mount(undefined, VersionInfo, scenario);
  try {
    await click(buttonIn(view.container, '更新核心服务'));
    const dialog = view.container.querySelector('[role="dialog"]');
    assert.ok(dialog.querySelector('[role="alert"]').textContent.includes('无法连接版本服务'));
    assert.equal(buttonIn(dialog, '开始更新').disabled, true);
    assert.ok(!globalThis.__calls.some(call => call.path === '/version/update' && call.method === 'POST'));
    scenario.checkError = '';
    await click(buttonIn(dialog, '重新检查'));
    assert.equal(dialog.querySelector('[role="alert"]'), null);
    assert.equal(buttonIn(dialog, '开始更新').disabled, false);
    assert.ok(dialog.textContent.includes('v26.10.1'));
  } finally { await view.close(); }
});

test('manual confirmation uses the selected mirror and permits reinstalling the latest version', async () => {
  const view = await mount(undefined, VersionInfo, {
    versionCheck: { currentVersion: '26.10.1', latestVersion: '26.10.1', hasNewVersion: false },
  });
  try {
    const select = view.container.querySelector('select[aria-label="更新源"]');
    await act(async () => { select.value = 'https://gh-proxy.org/'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
    await click(buttonIn(view.container, '更新核心服务'));
    assert.ok(view.container.textContent.includes('当前已是最新版本'));
    assert.equal(view.container.querySelector('.version-update-source select').value, 'https://gh-proxy.org/');
    assert.ok(!globalThis.__calls.some(call => call.path === '/version/update' && call.method === 'POST'));
    await click(buttonIn(view.container, '开始更新'));
    assert.deepEqual(globalThis.__calls.find(call => call.path === '/version/update' && call.method === 'POST').body, { source: 'https://gh-proxy.org/' });
  } finally { await view.close(); }
});

test('switching the source in the confirmation dialog persists it without starting an update', async () => {
  const view = await mount();
  try {
    await click(buttonIn(view.container, '更新核心服务'));
    const sourceSelect = view.container.querySelector('[role="dialog"] select[aria-label="更新源"]');
    assert.equal(sourceSelect.value, 'normal');
    await act(async () => {
      sourceSelect.value = 'https://ghfast.top/';
      sourceSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    assert.equal(dom.window.localStorage.getItem('loopra.updateSource'), 'https://ghfast.top/');
    assert.ok(!globalThis.__calls.some(call => call.path === '/version/update' && call.method === 'POST'));
    await click(buttonIn(view.container.querySelector('[role="dialog"]'), '关闭'));
    assert.equal(view.container.querySelector('select[aria-label="更新源"]').value, 'https://ghfast.top/');
    await click(buttonIn(view.container, '更新核心服务'));
    assert.equal(view.container.querySelector('[role="dialog"] select[aria-label="更新源"]').value, 'https://ghfast.top/');
    await click(buttonIn(view.container, '开始更新'));
    assert.deepEqual(globalThis.__calls.find(call => call.path === '/version/update' && call.method === 'POST').body, { source: 'https://ghfast.top/' });
  } finally { await view.close(); }
});

test('switching from a mirror to direct download clears the saved mirror', async () => {
  const view = await mount();
  try {
    await click(buttonIn(view.container, '更新核心服务'));
    const select = view.container.querySelector('[role="dialog"] select[aria-label="更新源"]');
    for (const source of ['https://gh-proxy.org/', 'normal']) {
      await act(async () => { select.value = source; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
    }
    assert.equal(dom.window.localStorage.getItem('loopra.updateSource'), null);
    assert.ok(!globalThis.__calls.some(call => call.path === '/version/update' && call.method === 'POST'));
    await click(buttonIn(view.container, '开始更新'));
    assert.deepEqual(globalThis.__calls.find(call => call.path === '/version/update' && call.method === 'POST').body, { source: 'normal' });
  } finally { await view.close(); }
});
