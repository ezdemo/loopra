import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
const { act, createElement } = await import('react');
const { Simulate } = await import('react-dom/test-utils');
const { createRoot } = await import('react-dom/client');
const reactUrl = import.meta.resolve('react');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
async function sourceUrl(path, dependencies = {}) {
  const source = await readFile(new URL(`../src/${path}`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
  for (const [specifier, url] of Object.entries({ react: reactUrl, 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), ...dependencies })) outputText = outputText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
  return dataUrl(outputText);
}
const ui = dataUrl(`const React = await import(${JSON.stringify(reactUrl)});
export const Button = ({children,onPress,isDisabled,isLoading,startContent,endContent,size,color,variant,as,...props}) => React.createElement(as || 'button',{...props,onClick:onPress,disabled:isDisabled||isLoading},children);
export const Switch = ({isSelected,onValueChange,isDisabled,size,...props}) => React.createElement('button',{...props,onClick:()=>onValueChange(!isSelected),disabled:isDisabled},String(isSelected));
export const Spinner = props => React.createElement('span',props,'loading');
export const Modal = ({children,isOpen,onClose}) => isOpen ? React.createElement('div',{role:'dialog'},children,React.createElement('button',{'aria-label':'Close',onClick:onClose},'Close')) : null;
export const ModalContent = ({children}) => React.createElement('div',null,children);
export const ModalHeader = ModalContent, ModalBody = ModalContent, ModalFooter = ModalContent;`);
const icons = dataUrl('export const Bot=()=>null, ExternalLink=()=>null, FolderOpen=()=>null, Plus=()=>null, RefreshCw=()=>null, Settings2=()=>null, Trash2=()=>null;');
const fields = dataUrl(`const React = await import(${JSON.stringify(reactUrl)});
export const Field = ({label,value,onChange,disabled,readOnly}) => React.createElement('label',null,label,React.createElement('input',{'aria-label':label,value,disabled,readOnly,onChange:e=>onChange(e.target.value)}));
export const TextField = ({label,value,onChange,disabled}) => React.createElement('label',null,label,React.createElement('textarea',{'aria-label':label,value,disabled,onChange:e=>onChange(e.target.value)}));
export const PageActions = ({title,children}) => React.createElement('header',null,React.createElement('h2',null,title),children);
export const SettingDisclosure = ({heading,children}) => React.createElement('section',{'aria-label':heading},children);`);
const basic = dataUrl(`const React = await import(${JSON.stringify(reactUrl)}); export const IconButton = ({label,children,onClick}) => React.createElement('button',{'aria-label':label,onClick},children);`);
const controls = await sourceUrl('components/RemoteControls.tsx', { '@nextui-org/react': ui });
const logic = await sourceUrl('bots.ts');
const Page = (await import(await sourceUrl('components/BotsPage.tsx', {
  '@nextui-org/react': ui, 'lucide-react': icons, '../bots': logic, './RemoteControls': controls, './SettingControls': fields, './ui': basic,
}))).default;
const bot = { id: 'one', name: '我的助手', platform: 'feishu', appId: 'cli-one', ownerId: 'ou-owner', workspaceHash: 'project', enabled: true, allowedUserIds: [], allowedChatIds: [], chats: [], state: 'connected', createdAt: 1 };
const project = { hash: 'project', name: 'Bot-飞书-abcde', path: '/bot' };
const button = (container, text) => [...container.querySelectorAll('button')].find(item => item.textContent === text);
async function mount(api, props = {}) {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Page, { api, workspaces: [project], onChanged: async () => {}, onManageProject() {}, onOpenSession() {}, ...props })));
  return { container, close: async () => { await act(async () => root.unmount()); container.remove(); } };
}

test('manages Bot settings and opens the existing project links and isolated sessions', async () => {
  const calls = [], projects = [], sessions = [];
  const api = { base: 'local', request: async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    return method === 'GET' ? [{ ...bot, chats: [{ chatId: 'oc-dm', chatType: 'p2p', sessionName: 'bot-session', updatedAt: 1 }] }] : {};
  } };
  const page = await mount(api, { onManageProject: value => projects.push(value), onOpenSession: (...args) => sessions.push(args) });
  try {
    assert.match(page.container.textContent, /已连接/);
    await act(async () => button(page.container, '管理').click());
    await act(async () => button(page.container, '关联项目').click());
    assert.deepEqual(projects, [project]);
    await act(async () => [...page.container.querySelectorAll('button')].find(item => item.textContent.includes('单聊 1')).click());
    assert.deepEqual(sessions, [['project', 'bot-session']]);
    await act(async () => Simulate.change(page.container.querySelector('[aria-label="名称"]'), { target: { value: '新名称' } }));
    await act(async () => Simulate.change(page.container.querySelector('[aria-label="其他允许用户的 Open ID"]'), { target: { value: 'ou-a\nou-b,ou-a' } }));
    await act(async () => button(page.container, '保存').click());
    const update = calls.find(call => call.method === 'PUT');
    assert.equal(update.path, '/bots/one');
    assert.deepEqual(update.body, { name: '新名称', enabled: true, allowedUserIds: ['ou-a', 'ou-b'], allowedChatIds: [] });
    assert.equal(page.container.querySelector('[role="dialog"]'), null);
  } finally { await page.close(); }
});

test('closing QR authorization cancels server polling and does not create a Bot', async () => {
  const calls = [];
  const api = { base: 'local', request: async (path, method = 'GET') => {
    calls.push({ path, method });
    if (path === '/bots') return [];
    if (method === 'POST') return { id: 'reg', state: 'starting' };
    if (method === 'DELETE') return {};
    return { id: 'reg', state: 'waiting', qrCode: 'data:image/png;base64,dGVzdA==', expiresAt: Date.now() + 60000 };
  } };
  const page = await mount(api);
  try {
    await act(async () => button(page.container, '添加 Bot').click());
    assert.ok(page.container.querySelector('img[alt="飞书授权二维码"]'));
    await act(async () => button(page.container, '取消').click());
    assert.ok(calls.some(call => call.path === '/bots/registrations/reg' && call.method === 'DELETE'));
    assert.match(page.container.textContent, /添加你的第一个 Bot/);
  } finally { await page.close(); }
});

test('closing while authorization is starting cancels its late result', async () => {
  const calls = [];
  let resolveStart;
  const start = new Promise(resolve => { resolveStart = resolve; });
  const api = { base: 'local', request: async (path, method = 'GET') => {
    calls.push({ path, method });
    if (path === '/bots') return [];
    if (method === 'POST') return start;
    return {};
  } };
  const page = await mount(api);
  try {
    await act(async () => button(page.container, '添加 Bot').click());
    await act(async () => button(page.container, '取消').click());
    await act(async () => resolveStart({ id: 'late', state: 'starting' }));
    assert.ok(calls.some(call => call.path === '/bots/registrations/late' && call.method === 'DELETE'));
    assert.ok(!calls.some(call => call.path === '/bots/registrations/late' && call.method === 'GET'));
  } finally { await page.close(); }
});

test('successful scan refreshes projects; save failure keeps the draft', async () => {
  let changed = 0;
  const api = { base: 'local', request: async (path, method = 'GET') => {
    if (path === '/bots') return [bot];
    if (method === 'PUT') throw new Error('保存失败');
    if (method === 'POST') return { id: 'reg', state: 'starting' };
    return { id: 'reg', state: 'completed', botId: 'one' };
  } };
  const page = await mount(api, { onChanged: async () => { changed++; } });
  try {
    await act(async () => button(page.container, '添加 Bot').click());
    assert.equal(changed, 1);
    assert.equal(page.container.querySelector('[role="dialog"]'), null);
    await act(async () => button(page.container, '管理').click());
    await act(async () => Simulate.change(page.container.querySelector('[aria-label="名称"]'), { target: { value: '保留草稿' } }));
    await act(async () => button(page.container, '保存').click());
    assert.match(page.container.textContent, /保存失败/);
    assert.equal(page.container.querySelector('[aria-label="名称"]').value, '保留草稿');
  } finally { await page.close(); }
});
