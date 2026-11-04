import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { fieldStubs } from './helpers/form-controls.mjs';
import { nextUIControlStubs } from './helpers/nextui-controls.mjs';

const dom = new JSDOM('<html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const reactImport = `import { createElement } from ${JSON.stringify(import.meta.resolve('react'))};\n`;
async function sourceUrl(name, dependencies = {}) {
  const source = (await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8')).replace(/^import '\.\/memory-settings\.css';\r?\n/m, '');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
  for (const [specifier, url] of Object.entries({ react: import.meta.resolve('react'), 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), ...dependencies })) {
    outputText = outputText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
  }
  return dataUrl(outputText);
}
const nextui = dataUrl(reactImport + nextUIControlStubs + `
export const Modal = ({children}) => createElement('div', null, children);
export const ModalBody = Modal, ModalContent = Modal, ModalFooter = Modal, ModalHeader = Modal;
export const Spinner = () => createElement('span', null, 'loading');
`);
const controls = dataUrl(reactImport + fieldStubs.replace('readOnly, disabled, ...props', 'readOnly, disabled, startContent, ...props') + `
export const EmptySetting = ({children}) => createElement('p', null, children);
export const SettingSegments = ({label, options, value, onChange}) => createElement('div', {'aria-label':label}, options.map(option=>createElement('button', {key:option,type:'button','aria-pressed':value===option,onClick:()=>onChange(option)}, option)));
`);
const memoryUrl = await sourceUrl('memory.ts');
const { memoryPath } = await import(memoryUrl);
const remoteUrl = await sourceUrl('components/RemoteControls.tsx', { '@nextui-org/react': nextui });
const MemorySettings = (await import(await sourceUrl('components/MemorySettings.tsx', {
  '@nextui-org/react': nextui,
  'lucide-react': dataUrl('export const Plus=()=>null, RefreshCw=()=>null, Search=()=>null;'),
  '../backend': dataUrl(`export const isChatWorkspace = item => item?.hash === '__loopra_chat__';`),
  '../memory': memoryUrl,
  './SettingControls': controls,
  './RemoteControls': remoteUrl,
}))).default;

const initial = { id: 'global-id', title: 'Node 版本管理', content: '使用 nvm', kind: 'environment', source: 'agent', revision: 3, createdAt: '', updatedAt: '' };
async function mount(override) {
  const calls = [];
  const scopes = { global: [{ ...initial }], a: [], b: [] };
  const api = { base: 'http://test.invalid', async request(path, method = 'GET', body, signal) {
    calls.push({ path, method, body, signal });
    if (override) {
      const result = override(path, method, body, signal);
      if (result !== undefined) return result;
    }
    const url = new URL(path, api.base);
    const scope = url.searchParams.get('scope') === 'global' ? 'global' : url.searchParams.get('workspaceHash');
    if (method === 'GET') return scopes[scope].map(item => ({ ...item }));
    if (method === 'POST') { scopes[scope].push({ ...body, id: 'new', revision: 1 }); return scopes[scope].at(-1); }
    if (method === 'PUT') { scopes[scope][0] = { ...scopes[scope][0], ...body, revision: body.revision + 1 }; return scopes[scope][0]; }
    if (method === 'DELETE') { scopes[scope] = []; return 'ok'; }
    throw new Error(`unexpected ${method} ${path}`);
  } };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(MemorySettings, { api, workspaces: [{ hash:'a',name:'项目 A' },{ hash:'b',name:'项目 B' }], initialWorkspaceHash: 'a', onNestedDialog: () => {} })));
  const view = {
    container, calls, scopes,
    async click(label) { await act(async () => { const button = [...container.querySelectorAll('button')].find(node => node.textContent === label); assert.ok(button, `missing button ${label}`); button.click(); }); },
    async type(label, value) { await act(async () => { const input = container.querySelector(`[aria-label="${label}"]`); assert.ok(input, `missing input ${label}`); const prototype = input.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); }); },
    async submit() { await act(async () => container.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))); },
    async close() { await act(async () => root.unmount()); container.remove(); },
  };
  return view;
}

test('memory routes keep global data independent of the selected project', () => {
  assert.equal(memoryPath('global', 'a'), '/memories?scope=global');
  assert.equal(memoryPath('project', 'a', 'id /', 3), '/memories/id%20%2F?scope=project&workspaceHash=a&revision=3');
});

test('edits keep the original revision and delete uses the refreshed revision', async () => {
  const view = await mount();
  try {
    await view.click('编辑');
    await view.type('内容', '使用 nvm-windows');
    await view.submit();
    const update = view.calls.find(call => call.method === 'PUT');
    assert.equal(update.path, '/memories/global-id?scope=global');
    assert.equal(update.body.revision, 3);
    assert.equal(update.body.content, '使用 nvm-windows');
    assert.match(view.container.textContent, /使用 nvm-windows/);
    await view.click('删除');
    await view.click('确认');
    assert.equal(view.calls.find(call => call.method === 'DELETE').path, '/memories/global-id?scope=global&revision=4');
    assert.match(view.container.textContent, /还没有全局记忆/);
  } finally { await view.close(); }
});

test('failed saves retain the draft and allow retry', async () => {
  let fail = true;
  const view = await mount((path, method) => { if (method === 'PUT' && fail) return Promise.reject(new Error('记忆已被更新，请重新加载后再操作')); });
  try {
    await view.click('编辑');
    await view.type('内容', '保留这段输入');
    await view.submit();
    assert.match(view.container.querySelector('[role="alert"]').textContent, /已被更新/);
    assert.equal(view.container.querySelector('textarea').value, '保留这段输入');
    fail = false;
    await view.submit();
    assert.match(view.container.textContent, /保留这段输入/);
  } finally { await view.close(); }
});

test('a late global response cannot populate the project collection', async () => {
  let resolveGlobal;
  const view = await mount((path, method) => path === '/memories?scope=global' && method === 'GET' ? new Promise(resolve => { resolveGlobal = resolve; }) : undefined);
  try {
    await view.click('项目');
    await act(async () => resolveGlobal([initial]));
    assert.doesNotMatch(view.container.textContent, /使用 nvm/);
    assert.match(view.container.textContent, /还没有项目记忆/);
    assert.equal(view.calls[0].signal.aborted, true);
    await view.click('添加');
    await view.type('标题', '包管理');
    await view.type('内容', '使用 pnpm');
    await view.submit();
    assert.equal(view.calls.find(call => call.method === 'POST').path, '/memories?scope=project&workspaceHash=a');
  } finally { await view.close(); }
});
