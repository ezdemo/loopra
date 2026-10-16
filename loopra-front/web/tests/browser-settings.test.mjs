import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// BrowserSettings only reads two endpoints and derives the browser_* subset from
// /tools, so stub the client and assert the status text plus the filtered count.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
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
export const Button = ({ children, onPress, isDisabled, isLoading, className, ...rest }) => createElement('button', { type: 'button', disabled: !!isDisabled || !!isLoading, onClick: onPress, className: className || undefined, ...rest }, children);
`);
const controlsStub = dataUrl(`
const React = await import(${JSON.stringify(reactUrl)});
export const errorText = cause => cause instanceof Error ? cause.message : String(cause);
export function useRemote(api, path, revision = 0) {
  const [state, setState] = React.useState({ data: undefined, error: '', loading: !!path });
  React.useEffect(() => { let live = true; setState({ data: undefined, error: '', loading: !!path }); if (!path) return undefined;
    api.request(path, 'GET').then(data => { if (live) setState({ data, error: '', loading: false }); }).catch(error => { if (live) setState({ data: undefined, error: errorText(error), loading: false }); });
    return () => { live = false; }; }, [api, path, revision]);
  return state;
}
export const RemoteState = ({ error }) => error ? React.createElement('p', { role: 'alert' }, error) : null;
`);
const settingControlsStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const PageHeader = ({ title, children }) => createElement('header', null, title, children);
export const PageActions = ({ title, children }) => createElement('header', null, createElement('h2', null, title), children);
export const ResourceEmpty = ({ title, children }) => createElement('div', null, title, children);
export const SettingDisclosure = ({ heading, children }) => createElement('details', null, createElement('summary', null, heading), children);
export const SettingRow = ({ title, description, children }) => createElement('div', { className: 'setting-row' }, createElement('strong', null, title), description ? createElement('span', null, description) : null, children);
`);
const BrowserSettings = (await import(await sourceUrl('components/BrowserSettings.tsx', {
  '@nextui-org/react': nextuiStub,
  './RemoteControls': controlsStub,
  './SettingControls': settingControlsStub,
}))).default;

const tools = [
  { name: 'browser_navigate', description: '打开地址', readOnly: false, enabled: true },
  { name: 'browser_screenshot', description: '截图', readOnly: true, enabled: false },
  { name: 'read_file', description: '读取文件', readOnly: true, enabled: true },
];

async function mount({ bridge, toolsResult = tools }) {
  const api = { request: (path) => {
    if (path === '/system/browser-bridge') return Promise.resolve(bridge);
    if (path === '/tools') return Promise.resolve(toolsResult);
    return Promise.reject(new Error(`unexpected ${path}`));
  } };
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(BrowserSettings, { api })));
  return { container, async close() { await act(async () => root.unmount()); container.remove(); } };
}
const statusText = (container, title) => [...container.querySelectorAll('.setting-row')].find(row => row.querySelector('strong')?.textContent === title)?.querySelector('[role="status"]')?.textContent;

test('shows the disconnected bridge and counts browser_* tools', async () => {
  const view = await mount({ bridge: { registered: false, address: '' } });
  try {
    assert.equal(statusText(view.container, '桌面浏览器桥接'), '未连接（AI 浏览器仅在桌面端可用）');
    assert.equal(statusText(view.container, '浏览器工具'), '2 个');
    const listed = [...view.container.querySelectorAll('.setting-row strong')].map(node => node.textContent);
    assert.ok(listed.includes('browser_navigate'));
    assert.ok(listed.includes('browser_screenshot'));
    assert.ok(!listed.includes('read_file'));
    assert.match(view.container.textContent, /BRIDGE_UNAVAILABLE/);
  } finally { await view.close(); }
});

test('shows the connected address when the desktop bridge registers', async () => {
  const view = await mount({ bridge: { registered: true, address: 'ws://127.0.0.1:3399/bridge' } });
  try {
    assert.equal(statusText(view.container, '桌面浏览器桥接'), '已连接 · ws://127.0.0.1:3399/bridge');
  } finally { await view.close(); }
});

test('reports read-only and disabled flags for browser tools', async () => {
  const view = await mount({ bridge: { registered: true, address: 'ws://x' } });
  try {
    const row = title => [...view.container.querySelectorAll('.setting-row')].find(node => node.querySelector('strong')?.textContent === title);
    assert.equal(row('browser_screenshot').querySelector('.form-hint').textContent, '只读 · 已停用');
    assert.equal(row('browser_navigate').querySelector('.form-hint').textContent, '写入');
  } finally { await view.close(); }
});
