import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const dom = new JSDOM('<html><body></body></html>', { url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const reactUrl = import.meta.resolve('react');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
async function compile(name, dependencies) {
  const source = await readFile(new URL(`../src/components/${name}.tsx`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
  for (const [name, url] of Object.entries({ react: reactUrl, 'react-dom': import.meta.resolve('react-dom'), 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), ...dependencies })) {
    outputText = outputText.replaceAll(`'${name}'`, JSON.stringify(url)).replaceAll(`"${name}"`, JSON.stringify(url));
  }
  return dataUrl(outputText);
}
const nextui = dataUrl(`export const Spinner = () => null; export const Button = () => null; export const Modal = () => null; export const ModalBody = () => null; export const ModalContent = () => null; export const ModalFooter = () => null; export const ModalHeader = () => null;`);
const remote = await compile('RemoteControls', { '@nextui-org/react': nextui });
const fields = dataUrl(`import { createElement as h } from ${JSON.stringify(reactUrl)};
export const Field = ({ label, value, onChange }) => h('label', null, label, h('input', { value, onChange: event => onChange(event.target.value) }));
export const PageActions = () => null;
export const SettingDisclosure = () => null;
export const ResourceIcon = () => null;
export const ResourceEmpty = ({ title, children }) => h('section', null, h('h3', null, title), children);`);
const icons = await compile('plugin-icons', { 'lucide-react': import.meta.resolve('lucide-react') });
const capabilityUI = await compile('CapabilityUI', { 'lucide-react': import.meta.resolve('lucide-react') });
const { PluginCatalog } = await import(await compile('PluginCatalog', { './RemoteControls': remote, './SettingControls': fields, './plugin-icons': icons, './CapabilityUI': capabilityUI, 'lucide-react': import.meta.resolve('lucide-react') }));
const { ExtensionManager } = await import(await compile('ResourceManagers', {
  './PluginFrame': dataUrl('export const PluginFrame = () => null;'),
  './PluginCatalog': dataUrl('export const PluginCatalog = () => null;'),
  './SubAgentManager': dataUrl('export default () => null;'),
  './UsageDashboard': dataUrl('export const UsageDashboard = () => null;'),
  './RemoteControls': remote, './SettingControls': fields, './plugin-icons': icons,
  './CapabilityUI': capabilityUI, '@nextui-org/react': nextui, 'lucide-react': import.meta.resolve('lucide-react'),
}));
const first = 'https://github.com/acme/plugins';
const second = 'https://github.com/acme/other';
const entries = [{ id: 'alpha', name: 'Alpha', source: `${first}?path=plugins%2Falpha`, version: '1.0.0' }, { id: 'beta', name: 'Beta', source: `${first}?path=plugins%2Fbeta` }];

async function mount(override) {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container), calls = [], installations = [], uninstallations = [], updates = [];
  let sources = [first], installed = [{ id: 'alpha' }];
  const api = { request: async (path, method = 'GET', body, signal) => {
    calls.push({ path, method, body, signal });
    if (override) { const result = override(path, method, body, signal); if (result !== undefined) return result; }
    if (path === '/plugins/sources' && method === 'POST') { sources = [...sources, body.source]; return sources; }
    if (path === '/plugins/sources/remove') { sources = sources.filter(source => source !== body.source); return sources; }
    if (path === '/plugins/sources') return sources;
    if (path.startsWith('/plugins/catalog?')) return path.includes(encodeURIComponent(first)) ? entries : [];
    throw new Error(`Unexpected request: ${path}`);
  } };
  const render = () => root.render(createElement(PluginCatalog, { api, installed, busy: false, onInstall: async source => { installations.push(source); installed = [...installed, { id: 'beta' }]; render(); }, onUpdate: async id => { updates.push(id); }, onUninstall: id => { uninstallations.push(id); installed = installed.filter(pack => pack.id !== id); render(); } }));
  await act(async () => render());
  const click = text => act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === text || button.getAttribute('aria-label') === text).click());
  return { container, calls, installations, uninstallations, updates, click, close: () => act(async () => { root.unmount(); container.remove(); }) };
}

test('catalog installs and uninstalls the chosen plugin and updates its action', async () => {
  const view = await mount();
  try {
    const cards = view.container.querySelectorAll('.plugin-card');
    assert.equal(cards.length, 2);
    assert.equal(cards[0].querySelector('button').textContent, '更新');
    assert.equal(cards[0].querySelector('button').disabled, false);
    await view.click('卸载');
    assert.deepEqual(view.uninstallations, ['alpha']);
    assert.equal(view.container.querySelector('.plugin-card button').textContent, '安装');
    await act(async () => view.container.querySelectorAll('.plugin-card button')[1].click());
    assert.deepEqual(view.installations, [entries[1].source]);
    assert.equal(view.container.querySelectorAll('.plugin-card button')[1].textContent, '更新');
    assert.equal(view.container.querySelector('.plugin-card button').textContent, '安装');
    await view.click('刷新');
    assert.equal(view.calls.filter(call => call.path.startsWith('/plugins/catalog?')).length, 2);
  } finally { await view.close(); }
});

test('catalog updates an installed plugin by id and keeps uninstall available', async () => {
  const view = await mount();
  try {
    await view.click('更新');
    assert.deepEqual(view.updates, ['alpha']);
    assert.deepEqual(view.installations, []);
    assert.deepEqual(view.uninstallations, []);
    assert.equal([...view.container.querySelectorAll('.plugin-card button')].some(button => button.textContent === '卸载'), true);
  } finally { await view.close(); }
});

async function mountInstalled(updateRequest) {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container), calls = [];
  let version = '1.0.0', changes = 0;
  const api = { request: async (path, method = 'GET') => {
    calls.push({ path, method });
    if (path === '/plugins') return [
      { id: 'alpha', displayName: 'Alpha', version, enabled: false, source: 'alpha' },
      { id: 'builtin', displayName: 'Builtin', enabled: true, builtin: true },
    ];
    if (path === '/plugins/alpha/update') { await updateRequest(); version = '2.0.0'; return {}; }
    throw new Error(`Unexpected request: ${path}`);
  } };
  await act(async () => root.render(createElement(ExtensionManager, { api, embedded: true, view: 'installed', onChanged: () => { changes++; } })));
  return { container, calls, changes: () => changes, close: () => act(async () => { root.unmount(); container.remove(); }) };
}

test('installed plugin update locks actions while pending, refreshes version and preserves disabled state', async () => {
  let complete;
  const view = await mountInstalled(() => new Promise(resolve => { complete = resolve; }));
  try {
    assert.equal(view.container.querySelector('[aria-label="更新 Builtin"]'), null);
    await act(async () => view.container.querySelector('[aria-label="更新 Alpha"]').click());
    const button = view.container.querySelector('[aria-label="更新 Alpha"]');
    assert.equal(button.disabled, true);
    assert.equal(button.getAttribute('aria-busy'), 'true');
    assert.ok([...view.container.querySelectorAll('.plugin-card button')].every(button => button.disabled));
    await act(async () => { complete(); });
    assert.deepEqual(view.calls.filter(call => call.method === 'POST'), [{ path: '/plugins/alpha/update', method: 'POST' }]);
    assert.match(view.container.querySelector('.plugin-card-meta')?.textContent || view.container.textContent, /v2.0.0/);
    assert.equal(view.container.querySelector('[role="switch"]').getAttribute('aria-checked'), 'false');
    assert.equal(view.container.querySelector('[role="status"]').textContent, '插件已更新');
    assert.equal(view.changes(), 1);
  } finally { await view.close(); }
});

test('failed installed plugin updates show the error and allow retry', async () => {
  let fail = true;
  const view = await mountInstalled(async () => { if (fail) throw new Error('更新包无效'); });
  try {
    await act(async () => view.container.querySelector('[aria-label="更新 Alpha"]').click());
    assert.match(view.container.querySelector('[role="alert"]').textContent, /更新包无效/);
    assert.equal(view.container.querySelector('[aria-label="更新 Alpha"]').disabled, false);
    assert.equal(view.changes(), 0);
    assert.match(view.container.textContent, /v1.0.0/);
    fail = false;
    await act(async () => view.container.querySelector('[aria-label="更新 Alpha"]').click());
    assert.equal(view.container.querySelector('[role="alert"]'), null);
    assert.match(view.container.textContent, /v2.0.0/);
    assert.equal(view.changes(), 1);
  } finally { await view.close(); }
});

test('adding, switching and removing a source preserve installed plugins', async () => {
  const view = await mount();
  try {
    await view.click('管理源');
    await act(async () => {
      const input = view.container.querySelector('form input');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, second);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () => view.container.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(view.container.querySelector('select').value, second);
    assert.match(view.container.textContent, /仓库中暂无插件/);
    assert.equal(view.calls.find(call => call.method === 'POST').body.source, second);
    await view.click('移除 acme/other');
    assert.equal(view.container.querySelector('select').value, first);
    assert.equal([...view.container.querySelectorAll('.plugin-card button')].filter(button => button.textContent === '卸载').length, 1);
    await view.click('移除 acme/plugins');
    assert.match(view.container.textContent, /添加插件源/);
    assert.equal(view.calls.some(call => /\/install|\/uninstall|\/toggle/.test(call.path)), false);
  } finally { await view.close(); }
});

test('failed catalog requests remain visible and can be retried', async () => {
  let failed = true;
  const view = await mount(path => {
    if (failed && path.startsWith('/plugins/catalog?')) return Promise.reject(new Error('仓库没有提交'));
  });
  try {
    assert.match(view.container.querySelector('[role="alert"]').textContent, /仓库没有提交/);
    assert.equal(view.container.querySelector('.plugin-card'), null);
    failed = false;
    await view.click('刷新');
    assert.equal(view.container.querySelector('[role="alert"]'), null);
    assert.equal(view.container.querySelectorAll('.plugin-card').length, 2);
  } finally { await view.close(); }
});

test('uninstalled catalog cards render Lucide and bundled image icons with a letter fallback', async () => {
  const image = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
  const view = await mount(path => path.startsWith('/plugins/catalog?') ? [
    { ...entries[0], icon: { name: 'calendar' } },
    { ...entries[1], icon: { dataUrl: image } },
    { id: 'gamma', name: 'Gamma', source: 'gamma' },
    { id: 'hidden', name: 'Hidden', source: 'hidden', icon: { hidden: true } },
  ] : undefined);
  try {
    const cards = view.container.querySelectorAll('.plugin-card');
    assert.ok(cards[0].querySelector('.plugin-card-mark svg.lucide-calendar'));
    assert.equal(cards[1].querySelector('.plugin-card-mark img').getAttribute('src'), image);
    assert.equal(cards[2].querySelector('.plugin-card-mark').textContent.trim(), 'G');
    assert.equal(cards[3].querySelector('.plugin-card-mark').childElementCount, 0);
    assert.equal(view.calls.some(call => call.path.includes('/icons/')), false);
  } finally { await view.close(); }
});

test('catalog search filters locally and keeps source management out of the main toolbar', async () => {
  const view = await mount();
  try {
    assert.equal(view.container.querySelector('.capability-source-panel'), null);
    const requests = view.calls.length;
    await act(async () => {
      const input = view.container.querySelector('input[type="search"]');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'beta');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    assert.equal(view.container.querySelectorAll('.plugin-card').length, 1);
    assert.equal(view.container.querySelector('.plugin-card h2').textContent, 'Beta');
    assert.equal(view.calls.length, requests);
    await view.click('管理源');
    assert.ok(view.container.querySelector('.capability-source-panel'));
  } finally { await view.close(); }
});
