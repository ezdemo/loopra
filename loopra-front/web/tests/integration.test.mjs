import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// DOM-only tests: no live backend, so MCP / OpenAPI writes are asserted on the
// exact request bodies instead of on a running server.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLSelectElement: dom.window.HTMLSelectElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
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
export const Button = ({ children, onPress, isDisabled, isLoading, isIconOnly, size, variant, color, ...rest }) =>
  createElement('button', { type: 'button', disabled: !!isDisabled || !!isLoading, onClick: onPress, ...rest }, children);
`);
const remoteStub = dataUrl(`
const React = await import(${JSON.stringify(reactUrl)});
export const errorText = cause => cause instanceof Error ? cause.message : String(cause);
export const query = values => new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])).toString();
export function useRemote(api, path, revision = 0) {
  const [data, setData] = React.useState();
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  React.useEffect(() => {
    if (!path) { setData(undefined); return; }
    let live = true;
    setLoading(true);
    api.request(path, 'GET').then(value => { if (live) setData(value); }).catch(cause => { if (live) setError(errorText(cause)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [api, path, revision]);
  return { data, error, loading, setData };
}
export const RemoteState = () => null;
export const ConfirmAction = () => null;
`);
const controlsStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const PageHeader = ({ title, children }) => createElement('header', null, title, children);
`);
const integrationUrl = await sourceUrl('integration.ts');
const managerUrl = await sourceUrl('components/IntegrationManager.tsx', { '@nextui-org/react': nextuiStub, './RemoteControls': remoteStub, './SettingControls': controlsStub, '../integration': integrationUrl });
const { default: IntegrationManager } = await import(managerUrl);

const exportConfig = {
  enabled: true, name: 'loopra', version: '1.0.0', channel: 'streamable', endpoint: '/mcp',
  allowedTools: null, endpointUrl: 'http://127.0.0.1:4567/mcp',
  tools: [{ name: 'read', description: '读取', enabled: true }, { name: 'write', description: '写入', enabled: true }, { name: 'browser_act', description: '浏览器', enabled: false }],
};
const tunnelStatus = {
  state: 'running', running: true, installed: true, quickTunnel: true, mcpReady: true, platform: 'windows',
  configuredExecutablePath: 'C:\\saved\\cloudflared.exe', executablePath: 'C:\\resolved\\cloudflared.exe',
  localUrl: 'http://127.0.0.1:4567/mcp', publicUrl: 'https://demo.trycloudflare.com/mcp', mcpEndpoint: '/mcp', error: '', pid: 4242,
};

function harness(responses) {
  const calls = [];
  const api = { request: async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    // Longest prefix wins so /mcp/tunnel/config can override /mcp/tunnel.
    const found = Object.entries(responses).sort(([a], [b]) => b.length - a.length).find(([prefix]) => path.startsWith(prefix));
    if (!found) throw new Error(`unexpected request ${method} ${path}`);
    const value = found[1];
    if (value instanceof Error) throw value;
    return typeof value === 'function' ? value(path, method, body) : structuredClone(value);
  } };
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  return { api, calls, container, root, async render(kind) { await act(async () => root.render(createElement(IntegrationManager, { api, kind }))); },
    async close() { await act(async () => root.unmount()); container.remove(); } };
}
const button = text => [...document.querySelectorAll('button')].find(element => element.textContent.trim() === text);
const field = label => document.querySelector(`[aria-label="${label}"]`);
async function type(element, value) {
  const prototype = element.tagName === 'SELECT' ? dom.window.HTMLSelectElement.prototype : element.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new dom.window.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  });
}

test('MCP publish config sends only McpExportConfig fields and an explicit tool whitelist', async () => {
  const view = harness({ '/mcp/servers': [], '/mcp/export': exportConfig, '/mcp/tunnel': tunnelStatus });
  try {
    await view.render('mcp');
    await act(async () => button('手动选择').click());
    const write = [...document.querySelectorAll('.mcp-export-tool')].find(row => row.textContent.includes('write')).querySelector('input');
    await act(async () => write.click());
    await act(async () => button('保存发布配置').click());
    const saved = view.calls.find(call => call.path === '/mcp/export' && call.method === 'PUT');
    assert.deepEqual(Object.keys(saved.body).sort(), ['allowedTools', 'channel', 'enabled', 'endpoint', 'name', 'version']);
    assert.ok(!('tools' in saved.body) && !('endpointUrl' in saved.body));
    assert.deepEqual(saved.body.allowedTools, ['read']);
    await act(async () => button('全部已启用').click());
    await act(async () => button('保存发布配置').click());
    assert.equal(view.calls.filter(call => call.path === '/mcp/export' && call.method === 'PUT').at(-1).body.allowedTools, null);
    await act(async () => button('刷新清单').click());
    assert.ok(view.calls.some(call => call.path === '/mcp/export/refresh' && call.method === 'POST'));
  } finally { await view.close(); }
});

test('Cloudflare tunnel saves the configured path, never the status DTO, and drives start/stop', async () => {
  const view = harness({ '/mcp/servers': [], '/mcp/export': exportConfig, '/mcp/tunnel': tunnelStatus });
  try {
    await view.render('mcp');
    assert.equal(field('cloudflared 路径').value, 'C:\\saved\\cloudflared.exe');
    await type(field('cloudflared 路径'), 'C:\\tools\\cloudflared.exe');
    await act(async () => button('保存路径').click());
    const config = view.calls.find(call => call.path === '/mcp/tunnel/config');
    assert.deepEqual(config, { path: '/mcp/tunnel/config', method: 'PUT', body: { executablePath: 'C:\\tools\\cloudflared.exe' } });
    // The running server must expose 停止 instead of starting a second tunnel.
    await act(async () => button('停止隧道').click());
    assert.ok(view.calls.some(call => call.path === '/mcp/tunnel/stop' && call.method === 'POST'));
  } finally { await view.close(); }
});

test('tunnel failures surface the server message and keep the path editable', async () => {
  const view = harness({ '/mcp/servers': [], '/mcp/export': exportConfig, '/mcp/tunnel': tunnelStatus, '/mcp/tunnel/config': new Error('cloudflared 不存在') });
  try {
    await view.render('mcp');
    await type(field('cloudflared 路径'), 'missing-cloudflared');
    await act(async () => { button('保存路径').click(); await Promise.resolve(); await Promise.resolve(); });
    assert.match(document.querySelector('[role="alert"]').textContent, /cloudflared 不存在/);
    assert.equal(field('cloudflared 路径').value, 'missing-cloudflared');
  } finally { await view.close(); }
});

test('OpenAPI sources submit the documented authConfig keys and header lines', async () => {
  const view = harness({ '/openapi/sources': [] });
  try {
    await view.render('openapi');
    await act(async () => button('新增').click());
    await type(document.querySelector('input[type="url"]'), 'https://api.example.test/openapi.json');
    await act(async () => button('保存').click());
    let body = view.calls.find(call => call.path === '/openapi/sources' && call.method === 'POST').body;
    assert.deepEqual(body, { docUrl: 'https://api.example.test/openapi.json', headers: {}, authType: 'none', authConfig: {} });

    await act(async () => button('新增').click());
    await type(document.querySelector('input[type="url"]'), 'https://api.example.test/openapi.json');
    await type(field('认证方式'), 'bearer');
    await type(field('Token'), 'secret-token');
    await type(field('请求头'), 'X-Tenant: demo\nAuthorization: Bearer inline');
    await act(async () => button('保存').click());
    body = view.calls.filter(call => call.path === '/openapi/sources' && call.method === 'POST').at(-1).body;
    assert.deepEqual(body, { docUrl: 'https://api.example.test/openapi.json', headers: { 'X-Tenant': 'demo', Authorization: 'Bearer inline' }, authType: 'bearer', authConfig: { token: 'secret-token' } });

    await act(async () => button('新增').click());
    await type(document.querySelector('input[type="url"]'), 'https://api.example.test/openapi.json');
    await type(field('认证方式'), 'apiKey');
    await type(field('参数名 name'), 'X-Api-Key');
    await type(field('参数值 value'), 'key-value');
    await act(async () => button('保存').click());
    body = view.calls.filter(call => call.path === '/openapi/sources' && call.method === 'POST').at(-1).body;
    assert.deepEqual(body.authConfig, { name: 'X-Api-Key', value: 'key-value' });
    assert.equal(body.authType, 'apiKey');
  } finally { await view.close(); }
});
