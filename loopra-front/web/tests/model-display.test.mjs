import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { fieldStubs } from './helpers/form-controls.mjs';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
const { act, createElement: h } = await import('react');
const { createRoot } = await import('react-dom/client');
const dataUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
async function moduleUrl(name, dependencies = {}) {
  let { outputText } = ts.transpileModule(await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
  for (const [specifier, url] of Object.entries({ react: import.meta.resolve('react'), 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), 'lucide-react': import.meta.resolve('lucide-react'), ...dependencies })) outputText = outputText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
  return dataUrl(outputText);
}
const settings = dataUrl(`import { createElement } from ${JSON.stringify(import.meta.resolve('react'))};
${fieldStubs.replace('export const Field =', 'const BaseField =')}
export const fieldRenders = [];
export const Field = props => { fieldRenders.push({ label: props.label, value: props.value }); return createElement(BaseField, props); };
export const ModelSelect = () => null;
export const SettingSwitch = () => null;`);
const { fieldRenders } = await import(settings);
const { default: ModelProviderSettings } = await import(await moduleUrl('components/ModelProviderSettings.tsx', {
  '@nextui-org/react': dataUrl(`import { createElement } from ${JSON.stringify(import.meta.resolve('react'))}; export const Button = ({ children, onPress, isDisabled, type = 'button' }) => createElement('button', { type, disabled: isDisabled, onClick: onPress }, children);`),
  '../composer': await moduleUrl('composer.ts'), '../settings-data': await moduleUrl('settings-data.ts'),
  './SettingControls': settings,
  './Motion': dataUrl('export const Enter = ({ children }) => children;'),
  './ui': dataUrl('export const LoopraMark = () => null;'),
  './RemoteModelsPicker': dataUrl('export default () => null;'),
}));
const backendUrl = await moduleUrl('backend.ts', { './diff': await moduleUrl('diff.ts') });
const { default: useLoopra } = await import(await moduleUrl('useLoopra.ts', { './backend': backendUrl }));

test('editing and clearing a display name saves it separately from the API model ID', async () => {
  const name = 'provider/very-long-model-id';
  const provider = { id: 'main', name: 'Main', type: 'responses', count: 1, models: [{ name, contextTokens: 128000, maxTokens: 32768, imageInput: false, priceEnabled: false, inputPrice: 0, cachePrice: 0, outputPrice: 0 }] };
  for (const [value, expected] of [['  中文展示名称  ', '中文展示名称'], ['', '']]) {
    const saved = [];
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    try {
      await act(async () => root.render(h(ModelProviderSettings, { providers: [{ ...provider, models: [{ ...provider.models[0], displayName: '旧名称' }] }], onProviders: async providers => saved.push(providers), config: {}, options: {}, notify() {} })));
      await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent.includes('Main')).click());
      const alias = host.querySelector('input[aria-label="展示名称"]');
      assert.equal(alias.value, '旧名称');
      await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(alias, value); alias.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
      assert.equal(host.querySelector('input[aria-label="模型 ID"]').value, name);
      await act(async () => host.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
      assert.equal(saved.length, 1);
      assert.equal(saved[0][0].models[0].displayName, expected);
      assert.equal(saved[0][0].models[0].name, name);
    } finally { await act(async () => root.unmount()); host.remove(); }
  }
});

test('a refreshed provider updates an untouched open editor but preserves a dirty draft', async () => {
  const model = { name: 'remote-magpie/plugin/long-model-id', contextTokens: 128000, maxTokens: 32768, imageInput: true };
  const provider = { id: 'magpie', name: 'Magpie', type: 'chat_completions', count: 1, models: [model] };
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const props = { onProviders() {}, config: {}, options: {}, notify() {} };
  const render = providers => act(async () => root.render(h(ModelProviderSettings, { ...props, providers })));
  try {
    await render([provider]);
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent.includes('Magpie')).click());
    assert.equal(host.querySelector('input[aria-label="展示名称"]').value, '');
    await render([{ ...provider, models: [{ ...model, displayName: 'DeepSeek V4.1 Flash' }] }]);
    assert.equal(host.querySelector('input[aria-label="展示名称"]').value, 'DeepSeek V4.1 Flash');
    assert.equal(host.querySelector('.settings-model-editor strong').textContent, 'DeepSeek V4.1 Flash');
    const alias = host.querySelector('input[aria-label="展示名称"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(alias, '我的草稿');
      alias.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await render([{ ...provider, models: [{ ...model, displayName: '后台新名称' }] }]);
    assert.equal(alias.value, '我的草稿');
    assert.equal(host.querySelector('input[aria-label="模型 ID"]').value, model.name);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test('config refresh and window focus reload model names without reloading sessions, and clean up on unmount', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  let displayName;
  let fail = false;
  globalThis.fetch = async url => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path === '/api/config' && fail) throw new Error('temporarily offline');
    const data = {
      '/api/config': { modelChannels: [{ id: 'magpie', name: 'Magpie', models: [{ name: 'remote/long-id', ...(displayName ? { displayName } : {}) }] }] },
      '/api/agent/status': { ready: false }, '/api/system/health': { version: '' }, '/api/workspaces': [],
    }[path];
    assert.notEqual(data, undefined, `unexpected request: ${path}`);
    return new Response(JSON.stringify({ success: true, data }));
  };
  let backend;
  function Harness() { backend = useLoopra('http://loopra.test'); return null; }
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(h(Harness)));
    assert.equal(backend.providers[0].models[0].displayName, undefined);
    const originalConfig = backend.config;
    calls.length = 0;
    displayName = 'DeepSeek V4.1 Flash';
    await act(async () => backend.refreshProviders());
    assert.equal(backend.providers[0].models[0].displayName, displayName);
    assert.deepEqual(calls, ['/api/config']);
    displayName = '更新的展示名称';
    await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
    assert.equal(backend.providers[0].models[0].displayName, displayName);
    assert.equal(backend.providers[0].models[0].name, 'remote/long-id');
    assert.equal(backend.config, originalConfig, 'a metadata refresh must not reapply global defaults to the composer');
    fail = true;
    await act(async () => window.dispatchEvent(new dom.window.Event('focus')));
    assert.equal(backend.providers[0].models[0].displayName, displayName, 'a failed refresh keeps existing data');
    await act(async () => root.unmount());
    const count = calls.length;
    window.dispatchEvent(new dom.window.Event('focus'));
    assert.equal(calls.length, count);
  } finally { await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch; }
});

test('large model catalogs keep all drafts while only rerendering the changed model card', async () => {
  const models = Array.from({ length: 37 }, (_, i) => ({ name: `remote/model-${i}`, displayName: `模型 ${i}`, contextTokens: 128000, maxTokens: 32768, imageInput: false, priceEnabled: false, inputPrice: 0, cachePrice: 0, outputPrice: 0 }));
  const provider = { id: 'magpie', name: 'Magpie', type: 'responses', count: models.length, models };
  const saved = [];
  const props = { providers: [provider], onProviders: value => saved.push(value), config: {}, options: {}, notify() {} };
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(h(ModelProviderSettings, props)));
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent.includes('Magpie')).click());
    assert.equal(host.querySelectorAll('.settings-model-editor').length, 37);
    fieldRenders.length = 0;
    const alias = host.querySelectorAll('input[aria-label="展示名称"]')[18];
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(alias, '编辑中的草稿');
      alias.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    assert.deepEqual(fieldRenders.filter(field => field.label === '模型 ID').map(field => field.value), ['remote/model-18']);
    fieldRenders.length = 0;
    await act(async () => root.render(h(ModelProviderSettings, { ...props, options: { effort: 'medium' } })));
    assert.equal(fieldRenders.filter(field => field.label === '模型 ID').length, 0, 'unrelated parent changes do not rerender model controls');
    await act(async () => host.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
    assert.equal(saved[0][0].models.length, 37);
    assert.equal(saved[0][0].models[18].displayName, '编辑中的草稿');
    assert.equal(saved[0][0].models[36].name, 'remote/model-36');
  } finally { await act(async () => root.unmount()); host.remove(); }
});
