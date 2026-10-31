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
  for (const [name, url] of Object.entries({ react: reactUrl, 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), ...dependencies })) {
    outputText = outputText.replaceAll(`'${name}'`, JSON.stringify(url)).replaceAll(`"${name}"`, JSON.stringify(url));
  }
  return dataUrl(outputText);
}
const nextui = dataUrl(`export const Spinner = () => null; export const Button = () => null; export const Modal = () => null; export const ModalBody = () => null; export const ModalContent = () => null; export const ModalFooter = () => null; export const ModalHeader = () => null;`);
const remote = await compile('RemoteControls', { '@nextui-org/react': nextui });
const fields = dataUrl(`import { createElement as h } from ${JSON.stringify(reactUrl)};
export const Field = ({ label, value, onChange }) => h('label', null, label, h('input', { value, onChange: event => onChange(event.target.value) }));
export const ResourceEmpty = ({ title, children }) => h('section', null, h('h3', null, title), children);`);
const { PluginCatalog } = await import(await compile('PluginCatalog', { './RemoteControls': remote, './SettingControls': fields }));
const first = 'https://github.com/acme/plugins';
const second = 'https://github.com/acme/other';
const entries = [{ id: 'alpha', name: 'Alpha', source: `${first}?path=plugins%2Falpha`, version: '1.0.0' }, { id: 'beta', name: 'Beta', source: `${first}?path=plugins%2Fbeta` }];

async function mount(override) {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container), calls = [], installations = [];
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
  const render = () => root.render(createElement(PluginCatalog, { api, installed, busy: false, onInstall: async source => { installations.push(source); installed = [...installed, { id: 'beta' }]; render(); } }));
  await act(async () => render());
  const click = text => act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === text).click());
  return { container, calls, installations, click, close: () => act(async () => { root.unmount(); container.remove(); }) };
}

test('catalog installs only the chosen plugin and prevents reinstalling installed IDs', async () => {
  const view = await mount();
  try {
    const cards = view.container.querySelectorAll('.plugin-card');
    assert.equal(cards.length, 2);
    assert.equal(cards[0].querySelector('button').disabled, true);
    await view.click('安装');
    assert.deepEqual(view.installations, [entries[1].source]);
    assert.equal(view.container.querySelectorAll('.plugin-card button:disabled').length, 2);
    await view.click('刷新');
    assert.equal(view.calls.filter(call => call.path.startsWith('/plugins/catalog?')).length, 2);
  } finally { await view.close(); }
});

test('adding, switching and removing a source preserve installed plugins', async () => {
  const view = await mount();
  try {
    await view.click('添加源');
    await act(async () => {
      const input = view.container.querySelector('input');
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, second);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await act(async () => view.container.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(view.container.querySelector('select').value, second);
    assert.match(view.container.textContent, /仓库中暂无插件/);
    assert.equal(view.calls.find(call => call.method === 'POST').body.source, second);
    await view.click('移除源');
    assert.equal(view.container.querySelector('select').value, first);
    assert.equal(view.container.querySelectorAll('.plugin-card button:disabled').length, 1);
    await view.click('移除源');
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
