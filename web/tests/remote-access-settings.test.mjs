import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { nextUIControlStubs } from './helpers/nextui-controls.mjs';

const dom = new JSDOM('<html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const reactImport = `import { createElement } from ${JSON.stringify(import.meta.resolve('react'))};\n`;
async function sourceUrl(name, dependencies = {}) {
  const source = (await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8')).replace(/^import '\.\/remote-access-settings\.css';\r?\n/m, '');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
  for (const [specifier, url] of Object.entries({ react: import.meta.resolve('react'), 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), ...dependencies })) outputText = outputText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
  return dataUrl(outputText);
}
const nextui = dataUrl(reactImport + nextUIControlStubs + `
export const Modal = ({children}) => createElement('div', {role:'dialog'}, children);
export const ModalBody = ({children}) => createElement('div', null, children);
export const ModalContent = ModalBody, ModalFooter = ModalBody, ModalHeader = ModalBody;
export const Spinner = () => createElement('span', null, 'loading');
`);
const controls = dataUrl(reactImport + `
export const PageActions = ({title,children}) => createElement('header', null, createElement('h2',null,title), children);
export const Field = ({label,value,onChange,endContent,disabled,required,...props}) => createElement('label',null,label,createElement('input',{...props,'aria-label':label,value,disabled,required,onChange:e=>onChange(e.target.value)}),endContent);
export const TextField = ({label,value,onChange,isReadOnly,rows}) => createElement('textarea',{'aria-label':label,value,readOnly:isReadOnly,rows,onChange:e=>onChange(e.target.value)});
export const SettingSegments = ({label,options,value,onChange}) => createElement('div',{'aria-label':label},options.map(option=>createElement('button',{key:option,type:'button','aria-pressed':value===option,onClick:()=>onChange(option)},option)));
`);
const remote = await sourceUrl('components/RemoteControls.tsx', { '@nextui-org/react': nextui });
const hook = await sourceUrl('useRemoteRelay.ts');
const Component = (await import(await sourceUrl('components/RemoteAccessSettings.tsx', {
  '@nextui-org/react': nextui,
  'lucide-react': dataUrl('export const Copy=()=>null, Download=()=>null, RefreshCw=()=>null, Trash2=()=>null;'),
  '../useRemoteRelay': hook,
  './SettingControls': controls,
  './RemoteControls': remote,
  './ui': dataUrl(reactImport + `export const IconButton=({label,onClick,children,isDisabled})=>createElement('button',{type:'button','aria-label':label,onClick,disabled:isDisabled},children);`),
}))).default;
const initial = { enabled: false, state: 'disabled', relayUrl: 'https://relay.example', hasRegistrationKey: true };
const paired = { ...initial, enabled: true, state: 'connected', pairingLink: 'loopra://connect?synthetic-fixture', qrCode: 'data:image/png;base64,c3ludGhldGlj' };

async function mount(override) {
  const calls = [];
  let status = { ...initial };
  const api = { base: 'http://test.invalid', async request(path, method = 'GET', body, signal) {
    calls.push({ path, method, body, signal });
    if (override) { const result = override(path,method,body,signal); if (result !== undefined) return result; }
    if (method === 'GET') return { ...status };
    if (method === 'PUT') status = body.enabled === false ? { ...status, enabled: false, state: 'disabled', pairingLink: undefined, qrCode: undefined } : { ...paired, relayUrl: body.relayUrl, hasRegistrationKey: body.registrationKey === '' ? false : true };
    if (method === 'POST') status = { ...paired, pairingLink: 'loopra://connect?rotated-fixture' };
    return { ...status };
  } };
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const render = async next => act(async () => root.render(createElement(Component,{api:next,notify:()=>{}})));
  await render(api);
  return { calls,container,api,render,
    async type(label,value) { await act(async () => { const input=container.querySelector(`[aria-label="${label}"]`); assert.ok(input); Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(input,value); input.dispatchEvent(new dom.window.Event('input',{bubbles:true})); }); },
    async click(label) { await act(async () => { const button=[...container.querySelectorAll('button')].find(node=>node.textContent===label||node.getAttribute('aria-label')===label); assert.ok(button,`missing ${label}`); button.click(); }); },
    async submit() { await act(async () => container.querySelector('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}))); },
    async close() { await act(async () => root.unmount()); container.remove(); },
  };
}

test('save preserves an existing secret and renders pairing link and QR', async () => {
  const view=await mount();
  try {
    assert.equal(view.container.querySelector('[aria-label="注册密钥（可选）"]').value,'');
    assert.equal(view.container.querySelector('[aria-label="注册密钥（可选）"]').type,'pass'+'word');
    await view.type('中继地址','https://new.example');
    await view.submit();
    const write=view.calls.find(call=>call.method==='PUT');
    assert.deepEqual(write.body,{enabled:true,relayUrl:'https://new.example'});
    assert.equal(view.container.querySelector('[alt="Loopra Mobile 配对二维码"]').getAttribute('src'),paired.qrCode);
    assert.equal(view.container.querySelector('[aria-label="配对链接"]').value,paired.pairingLink);
    await view.click('停用');
    assert.deepEqual(view.calls.filter(call=>call.method==='PUT').at(-1).body,{enabled:false});
    assert.equal(view.container.querySelector('[aria-label="配对链接"]'),null);
  } finally { await view.close(); }
});

test('clearing a secret is explicit and failed saves preserve the form draft', async () => {
  const view=await mount((_path,method)=>method==='PUT'?Promise.reject(new Error('保存失败')):undefined);
  try {
    await view.type('中继地址','https://draft.example');
    await view.click('清除注册密钥');
    await view.submit();
    assert.equal(view.calls.find(call=>call.method==='PUT').body.registrationKey,'');
    assert.equal(view.container.querySelector('[aria-label="中继地址"]').value,'https://draft.example');
    assert.ok(view.container.textContent.includes('保存失败'));
  } finally { await view.close(); }
});

test('pairing rotation requires confirmation', async () => {
  const view=await mount((_path,method)=>method==='GET'?{...paired}:undefined);
  try {
    await view.click('重置配对');
    assert.equal(view.calls.filter(call=>call.method==='POST').length,0);
    await view.click('取消');
    assert.equal(view.calls.filter(call=>call.method==='POST').length,0);
    await view.click('重置配对'); await view.click('确认');
    assert.equal(view.calls.find(call=>call.method==='POST').path,'/remote/relay/reset-pairing');
    assert.equal(view.container.querySelector('[aria-label="配对链接"]').value,'loopra://connect?rotated-fixture');
  } finally { await view.close(); }
});

test('switching backend aborts old requests and prevents stale pairing data', async () => {
  let resolve;
  const view=await mount(()=>new Promise(done=>{resolve=done;}));
  try {
    const old=view.calls[0];
    await view.render({base:'http://other.invalid',request:async()=>({...initial,relayUrl:'https://other.example'})});
    assert.equal(old.signal.aborted,true);
    await act(async()=>resolve({...paired}));
    assert.equal(view.container.querySelector('[aria-label="中继地址"]').value,'https://other.example');
    assert.equal(view.container.querySelector('[aria-label="配对链接"]'),null);
  } finally { await view.close(); }
});
