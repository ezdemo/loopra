import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// ProxySettings 只依赖配置接口和 Electron 桥接；这里替换 UI 边界，
// 其余（校验、规范化、保存流程）都走真实实现。
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
// 每个测试文件在独立进程中运行，保留 dom 全局直到进程退出即可。
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

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

const proxyUrl = await sourceUrl('proxy.ts');
const proxy = await import(proxyUrl);

test('normalizes HTTP and SOCKS addresses like the backend', () => {
  assert.equal(proxy.normalizeProxyAddress(''), '');
  assert.equal(proxy.normalizeProxyAddress('127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(proxy.normalizeProxyAddress('http://localhost'), 'http://localhost:80');
  assert.equal(proxy.normalizeProxyAddress('socks5h://localhost:1080'), 'socks5://localhost:1080');
  assert.equal(proxy.normalizeProxyAddress('socks4://[::1]'), 'socks5://[::1]:1080');
  assert.match(proxy.proxyAddressError('https://127.0.0.1:7890'), /仅支持 http 或 socks5/);
  assert.match(proxy.proxyAddressError('http://user:secret@127.0.0.1:7890'), /用户名、密码/);
  assert.match(proxy.proxyAddressError('http://127.0.0.1:7890/path'), /路径或查询参数/);
  assert.equal(proxy.proxyAddressError('socks5://127.0.0.1:1080'), '');
});

const nextuiStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const Button = ({ children, onPress, isDisabled, isLoading, type = 'button', className, ...rest }) => createElement('button', { type, disabled: !!isDisabled || !!isLoading, onClick: onPress, className: className || undefined, ...rest }, children);
`);
const settingControlsStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const PageActions = ({ title, children }) => createElement('header', null, createElement('h2', null, title), children);
export const SettingRow = ({ title, description, children }) => createElement('div', { className: 'setting-row' }, createElement('strong', null, title), description ? createElement('span', null, description) : null, children);
export const Field = ({ label, value, onChange, placeholder }) => createElement('input', { 'aria-label': label, value, placeholder, onChange: event => onChange(event.target.value) });
`);
const desktopShellStub = dataUrl('export const electronProxyApi = () => globalThis.__loopraProxyBridge || null;\n');
const ProxySettings = (await import(await sourceUrl('components/ProxySettings.tsx', {
  '@nextui-org/react': nextuiStub,
  './SettingControls': settingControlsStub,
  '../desktop-shell': desktopShellStub,
  '../proxy': proxyUrl,
}))).default;

beforeEach(() => { delete globalThis.__loopraProxyBridge; });

async function mount({ proxyValue = '', bridge, getError, putError } = {}) {
  if (bridge) globalThis.__loopraProxyBridge = bridge;
  const requests = [];
  const notices = [];
  let config = { proxy: proxyValue };
  const api = {
    request: async (path, method = 'GET', body) => {
      requests.push({ path, method, body });
      if (path === '/config' && method === 'GET') {
        if (getError) throw getError;
        return { ...config };
      }
      if (path === '/config' && method === 'PUT') {
        if (putError) throw putError;
        config = { ...config, ...body };
        return 'ok';
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(ProxySettings, { api, notify: message => notices.push(message) })));
  await act(async () => { await Promise.resolve(); });
  return {
    container, requests, notices,
    input: () => container.querySelector('input'),
    button: label => [...container.querySelectorAll('button')].find(node => node.textContent === label),
    async submit() {
      await act(async () => {
        container.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
        await Promise.resolve();
      });
    },
    async type(value) {
      const input = container.querySelector('input');
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
      await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      });
    },
    async close() { await act(async () => root.unmount()); container.remove(); delete globalThis.__loopraProxyBridge; },
  };
}

test('loads the saved proxy and writes the normalized address to both backends', async () => {
  const calls = [];
  const view = await mount({ proxyValue: 'http://127.0.0.1:7890', bridge: { set: async address => { calls.push(address); return { success: true, proxy: address }; } } });
  try {
    assert.equal(view.input().value, 'http://127.0.0.1:7890');
    assert.match(view.container.querySelector('[role="status"]').textContent, /已保存：http:\/\/127\.0\.0\.1:7890/);

    await view.type('socks5h://localhost:1080');
    await view.submit();

    const put = view.requests.find(request => request.method === 'PUT');
    assert.deepEqual(put.body, { proxy: 'socks5://localhost:1080' });
    assert.deepEqual(calls, ['socks5://localhost:1080']);
    assert.equal(view.input().value, 'socks5://localhost:1080');
    assert.deepEqual(view.notices, ['代理已保存：socks5://localhost:1080']);
  } finally { await view.close(); }
});

test('rejects unsupported schemes before calling the backend', async () => {
  const calls = [];
  const view = await mount({ bridge: { set: async address => { calls.push(address); return { success: true }; } } });
  try {
    await view.type('https://127.0.0.1:7890');
    await view.submit();

    assert.equal(view.requests.filter(request => request.method === 'PUT').length, 0);
    assert.deepEqual(calls, []);
    assert.match(view.container.querySelector('[role="alert"]').textContent, /仅支持 http 或 socks5/);
  } finally { await view.close(); }
});

test('closing the proxy saves an empty address and clears Electron', async () => {
  const calls = [];
  const view = await mount({ proxyValue: 'http://127.0.0.1:7890', bridge: { set: async address => { calls.push(address); return { success: true }; } } });
  try {
    await act(async () => { view.button('关闭代理').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await Promise.resolve(); });

    const put = view.requests.find(request => request.method === 'PUT');
    assert.deepEqual(put.body, { proxy: '' });
    assert.deepEqual(calls, ['']);
    assert.equal(view.container.querySelector('[role="status"]').textContent, '当前为直连');
  } finally { await view.close(); }
});

test('keeps the saved value but warns when the Electron session rejects it', async () => {
  const view = await mount({ bridge: { set: async () => ({ success: false, error: 'session unavailable' }) } });
  try {
    await view.type('127.0.0.1:7890');
    await view.submit();

    assert.deepEqual(view.requests.find(request => request.method === 'PUT').body, { proxy: 'http://127.0.0.1:7890' });
    assert.equal(view.input().value, 'http://127.0.0.1:7890');
    assert.match(view.notices[0], /代理已保存，但桌面端应用失败：session unavailable/);
  } finally { await view.close(); }
});

test('works in the browser without the Electron bridge', async () => {
  const view = await mount();
  try {
    await view.type('127.0.0.1:7890');
    await view.submit();

    assert.deepEqual(view.requests.find(request => request.method === 'PUT').body, { proxy: 'http://127.0.0.1:7890' });
    assert.deepEqual(view.notices, ['代理已保存：http://127.0.0.1:7890']);
  } finally { await view.close(); }
});

test('shows a read error instead of an empty form', async () => {
  const view = await mount({ getError: new Error('HTTP 500') });
  try {
    assert.match(view.container.querySelector('[role="alert"]').textContent, /读取代理配置失败：HTTP 500/);
  } finally { await view.close(); }
});
