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
export const SettingSwitch = ({label,value,onChange}) => createElement('input',{type:'checkbox','aria-label':label,checked:value,onChange:event=>onChange(event.target.checked)});`);
const { fieldRenders } = await import(settings);
const { default: ModelProviderSettings } = await import(await moduleUrl('components/ModelProviderSettings.tsx', {
  '@nextui-org/react': dataUrl(`import { createElement } from ${JSON.stringify(import.meta.resolve('react'))};
    export const Button = ({ children, onPress, isDisabled, type = 'button', className, ...props }) => createElement('button', { type, className, 'aria-label': props['aria-label'], disabled: isDisabled, onClick: onPress }, children);
    export const Modal=({isOpen,children,...props})=>isOpen?createElement('section',{role:'dialog','aria-label':props['aria-label']},children):null;
    export const ModalContent=({children})=>children;
    export const ModalBody=({children,className})=>createElement('div',{className},children);
    export const ModalHeader=ModalBody;
    export const ModalFooter=ModalBody;`),
  '../composer': await moduleUrl('composer.ts'), '../settings-data': await moduleUrl('settings-data.ts'),
  './SettingControls': settings,
  './Motion': dataUrl('export const Enter = ({ children }) => children;'),
  './ui': dataUrl('export const LoopraMark = () => null;'),
  './RemoteModelsPicker': dataUrl(`import {createElement} from ${JSON.stringify(import.meta.resolve('react'))}; export default ({provider,onAdd})=>provider?createElement('button',{'aria-label':'导入测试模型',onClick:()=>onAdd(['remote/model-0','fetched/new','fetched/new'])},'导入测试模型'):null;`),
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
      await act(async () => host.querySelector('.provider-model-open').click());
      const alias = host.querySelector('input[aria-label="展示名称"]');
      assert.equal(alias.value, '旧名称');
      await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(alias, value); alias.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
      assert.equal(host.querySelector('input[aria-label="模型 ID"]').value, name);
      await act(async () => host.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
      assert.equal(host.querySelector('[role="dialog"]'), null);
      await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === '保存渠道').click());
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
    await act(async () => host.querySelector('.provider-model-open').click());
    assert.equal(host.querySelector('input[aria-label="展示名称"]').value, '');
    await render([{ ...provider, models: [{ ...model, displayName: 'DeepSeek V4.1 Flash' }] }]);
    assert.equal(host.querySelector('input[aria-label="展示名称"]').value, 'DeepSeek V4.1 Flash');
    assert.equal(host.querySelector('.provider-model-identity strong').textContent, 'DeepSeek V4.1 Flash');
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

test('large catalogs mount only the selected model form and preserve every other model on save', async () => {
  const models = Array.from({ length: 37 }, (_, i) => ({ name: `remote/model-${i}`, displayName: `模型 ${i}`, contextTokens: 128000, maxTokens: 32768, imageInput: false, priceEnabled: false, inputPrice: 0, cachePrice: 0, outputPrice: 0 }));
  const provider = { id: 'magpie', name: 'Magpie', type: 'responses', count: models.length, models };
  const saved = [];
  const props = { providers: [provider], onProviders: value => saved.push(value), config: {}, options: {}, notify() {} };
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(h(ModelProviderSettings, props)));
    assert.equal(host.querySelectorAll('.provider-model-row').length, 37);
    assert.equal(host.querySelectorAll('input[aria-label="模型 ID"]').length, 0);
    await act(async () => host.querySelectorAll('.provider-model-open')[18].click());
    assert.equal(host.querySelectorAll('input[aria-label="模型 ID"]').length, 1);
    fieldRenders.length = 0;
    const alias = host.querySelector('input[aria-label="展示名称"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(alias, '编辑中的草稿');
      alias.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    assert.deepEqual(fieldRenders.filter(field => field.label === '模型 ID').map(field => field.value), ['remote/model-18']);
    fieldRenders.length = 0;
    await act(async () => root.render(h(ModelProviderSettings, { ...props, options: { effort: 'medium' } })));
    assert.equal(host.querySelector('input[aria-label="展示名称"]').value, '编辑中的草稿');
    await act(async () => host.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === '保存渠道').click());
    assert.equal(saved[0][0].models.length, 37);
    assert.equal(saved[0][0].models[18].displayName, '编辑中的草稿');
    assert.equal(saved[0][0].models[36].name, 'remote/model-36');
  } finally { await act(async () => root.unmount()); host.remove(); }
});

const modelFixture = name => ({ name, contextTokens: 128000, maxTokens: 32768, imageInput: false, priceEnabled: false, inputPrice: 0, cachePrice: 0, outputPrice: 0 });
const providerFixture = (id, names = [`${id}/model`]) => ({ id, name: id, type: 'responses', baseUrl: `https://${id}.example/v1`, apiKey: '****', count: names.length, models: names.map(modelFixture) });
async function providerUI(providers, overrides = {}) {
  const saved = [], notices = [];
  const props = { server: 'http://test.invalid', providers, onProviders: value => saved.push(value), config: {}, options: {}, notify: value => notices.push(value), ...overrides };
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  const render = next => act(async () => root.render(h(ModelProviderSettings, { ...props, ...next })));
  await render({});
  return { host, saved, notices, render,
    click: selector => act(async () => host.querySelector(selector).click()),
    text: text => act(async () => { const button = [...host.querySelectorAll('button')].find(button => button.textContent === text); assert.ok(button, `missing button: ${text}`); button.click(); }),
    input: (label, value) => act(async () => { const input = host.querySelector(`input[aria-label="${label}"]`); Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); }),
    apply: () => act(async () => host.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))),
    close: async () => { await act(async () => root.unmount()); host.remove(); },
  };
}

test('switching channels preserves independent drafts and saves only the selected channel', async () => {
  const a = providerFixture('A'), b = providerFixture('B');
  const ui = await providerUI([a, b]);
  try {
    await ui.input('API 地址', 'https://a-new.example/v1');
    await ui.click('.provider-channel[title="B"]');
    assert.equal(ui.host.querySelector('input[aria-label="API 地址"]').value, b.baseUrl);
    assert.equal(ui.host.querySelector('.provider-model-open').title, 'B/model');
    await ui.input('API 地址', 'https://b-draft.example/v1');
    await ui.click('.provider-channel[title="A"]');
    assert.equal(ui.host.querySelector('input[aria-label="API 地址"]').value, 'https://a-new.example/v1');
    await ui.text('保存渠道');
    assert.equal(ui.saved[0][0].baseUrl, 'https://a-new.example/v1');
    assert.equal(ui.saved[0][1].baseUrl, b.baseUrl);
    await ui.render({ providers: ui.saved[0] });
    await ui.click('.provider-channel[title="B"]');
    assert.equal(ui.host.querySelector('input[aria-label="API 地址"]').value, 'https://b-draft.example/v1');
    await ui.text('取消更改');
    assert.equal(ui.host.querySelector('input[aria-label="API 地址"]').value, b.baseUrl);
  } finally { await ui.close(); }
});

test('model dialog cancellation leaves the saved model and channel draft untouched', async () => {
  const ui = await providerUI([providerFixture('A')]);
  try {
    await ui.click('.provider-model-open'); await ui.input('展示名称', 'discard this');
    await ui.text('取消');
    assert.equal(ui.host.querySelector('[role="dialog"]'), null);
    assert.equal(ui.host.querySelector('.provider-model-identity strong').textContent, 'A/model');
    assert.equal([...ui.host.querySelectorAll('button')].find(button => button.textContent === '保存渠道').disabled, true);
    assert.equal(ui.saved.length, 0);
  } finally { await ui.close(); }
});

test('search edits the original model index and validates duplicates and token limits', async () => {
  const ui = await providerUI([providerFixture('A', ['a', 'b', 'c'])]);
  try {
    await ui.input('搜索当前渠道模型', 'c');
    assert.equal(ui.host.querySelectorAll('.provider-model-row').length, 1);
    await ui.click('.provider-model-open');
    await ui.input('模型 ID', 'a'); await ui.apply();
    assert.match(ui.host.querySelector('[role="alert"]').textContent, /重复/);
    await ui.input('模型 ID', 'c-new'); await ui.input('最大输出（tokens）', '999999'); await ui.apply();
    assert.match(ui.host.querySelector('[role="alert"]').textContent, /不能超过/);
    await ui.input('最大输出（tokens）', '32000'); await ui.input('展示名称', '新名称'); await ui.apply();
    await ui.text('保存渠道');
    assert.deepEqual(ui.saved[0][0].models.map(model => model.name), ['a', 'b', 'c-new']);
    assert.equal(ui.saved[0][0].models[2].displayName, '新名称');
  } finally { await ui.close(); }
});

test('new model parameters and pricing survive applying and saving the channel', async () => {
  const ui = await providerUI([providerFixture('A')]);
  try {
    await ui.text('添加模型'); await ui.input('模型 ID', 'new/id'); await ui.input('展示名称', 'New model');
    await ui.click('input[aria-label="支持图片输入"]'); await ui.click('input[aria-label="自定义价格"]');
    await ui.input('输入', '1.5'); await ui.input('缓存', '0.25'); await ui.input('输出', '3');
    await ui.apply(); await ui.text('保存渠道');
    assert.deepEqual(ui.saved[0][0].models[1], { ...modelFixture('new/id'), displayName: 'New model', imageInput: true, priceEnabled: true, inputPrice: 1.5, cachePrice: 0.25, outputPrice: 3 });
    assert.equal(ui.saved[0][0].apiKey, '****');
  } finally { await ui.close(); }
});

test('failed channel save retains edits and can be retried', async () => {
  let fail = true; const saved = [];
  const ui = await providerUI([providerFixture('A')], { onProviders: async value => { if (fail) throw new Error('offline'); saved.push(value); } });
  try {
    await ui.input('渠道名称', 'A draft'); await ui.text('保存渠道');
    assert.match(ui.host.querySelector('[role="alert"]').textContent, /offline/);
    assert.equal(ui.host.querySelector('input[aria-label="渠道名称"]').value, 'A draft');
    fail = false; await ui.text('保存渠道');
    assert.equal(saved[0][0].name, 'A draft');
  } finally { await ui.close(); }
});

test('channel copying clears credentials and canceling a new channel makes no server change', async () => {
  const ui = await providerUI([providerFixture('A')]);
  try {
    await ui.click('[aria-label="复制当前渠道"]');
    assert.equal(ui.host.querySelector('input[aria-label="渠道名称"]').value, 'A 副本');
    assert.equal(ui.host.querySelector('input[aria-label="API 密钥"]').value, '');
    assert.equal(ui.host.querySelectorAll('.provider-model-row').length, 1);
    await ui.text('取消更改');
    assert.equal(ui.host.querySelectorAll('.provider-channel').length, 1);
    assert.equal(ui.saved.length, 0);
  } finally { await ui.close(); }
});

test('remote import deduplicates models and removing a filtered row keeps the remaining models', async () => {
  const ui = await providerUI([providerFixture('A', ['remote/model-0', 'remote/model-1'])]);
  try {
    await ui.text('获取模型'); await ui.click('[aria-label="导入测试模型"]');
    assert.equal(ui.host.querySelectorAll('.provider-model-row').length, 3);
    await ui.input('搜索当前渠道模型', 'model-1'); await ui.click('.provider-model-remove');
    await ui.text('保存渠道');
    assert.deepEqual(ui.saved[0][0].models.map(model => model.name), ['remote/model-0', 'fetched/new']);
  } finally { await ui.close(); }
});

test('a channel removed by a catalog refresh keeps its local draft and can be saved again', async () => {
  const a = providerFixture('A'), b = providerFixture('B');
  const ui = await providerUI([a, b]);
  try {
    await ui.click('.provider-channel[title="A"]');
    await ui.input('API 地址', 'https://restore.example/v1');
    await ui.render({ providers: [b] });
    assert.equal(ui.host.querySelector('input[aria-label="API 地址"]').value, 'https://restore.example/v1');
    await ui.text('保存渠道');
    assert.equal(ui.saved[0].length, 2);
    assert.equal(ui.saved[0].find(provider => provider.id === 'A').baseUrl, 'https://restore.example/v1');
  } finally { await ui.close(); }
});

test('deleting one channel asynchronously cannot steal a newly selected channel', async () => {
  let finish;
  const providers = ['A', 'B', 'C'].map(id => providerFixture(id));
  const ui = await providerUI(providers, { onProviders: () => new Promise(resolve => { finish = resolve; }) });
  try {
    await ui.click('.provider-channel[title="A"]');
    await ui.click('[aria-label="删除当前渠道"]');
    await ui.click('.provider-channel[title="C"]');
    await act(async () => finish());
    assert.equal(ui.host.querySelector('.provider-channel.selected strong').textContent, 'C');
  } finally { await ui.close(); }
});
