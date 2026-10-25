import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { fieldStubs } from './helpers/form-controls.mjs';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const reactUrl = import.meta.resolve('react');
async function sourceUrl(name, dependencies = {}) {
  const source = await readFile(new URL(`../src/components/${name}.tsx`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
  for (const [specifier, url] of Object.entries({ react: reactUrl, 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), 'lucide-react': import.meta.resolve('lucide-react'), ...dependencies })) outputText = outputText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
  return dataUrl(outputText);
}
const ui = dataUrl(`
import { createElement } from ${JSON.stringify(reactUrl)};
export const Button = ({ children, onPress, isDisabled, isLoading, startContent, endContent, isIconOnly, variant, size, color, ...props }) => createElement('button', { type: 'button', ...props, disabled: isDisabled || isLoading, onClick: onPress }, children);
export const Modal = ({ children, isOpen, 'aria-label': label }) => isOpen ? createElement('div', { role: 'dialog', 'aria-label': label }, children) : null;
export const ModalContent = ({ children }) => createElement('div', null, children);
export const ModalBody = ModalContent, ModalHeader = ModalContent, ModalFooter = ModalContent;
export const Spinner = () => createElement('span', null, 'loading');
`);
const controls = await sourceUrl('RemoteControls', { '@nextui-org/react': ui });
const fields = dataUrl(`import {createElement} from ${JSON.stringify(reactUrl)}; ${fieldStubs.replace('onChange, readOnly, disabled, ...props', 'onChange, readOnly, disabled, startContent, ...props')}`);
const { default: SkillsPage } = await import(await sourceUrl('SkillsPage', { '@nextui-org/react': ui, './RemoteControls': controls, './SettingControls': fields }));
const button = (element, text) => [...element.querySelectorAll('button')].find(item => item.textContent.trim() === text);
async function click(element) { assert.ok(element); await act(async () => element.click()); }
async function input(element, value) { await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(element, value); element.dispatchEvent(new dom.window.Event('input', { bubbles: true })); }); }
async function mount({ failInstall = false, marketUrl = 'https://skillhub.cn/skills/author/code-review' } = {}) {
  const calls = []; let refreshes = 0, backs = 0;
  let installed = [{ name: 'self-skill', description: '内置技能完整说明' }, { name: 'ego-browser', description: '浏览器自动化' }];
  const api = { request: async (path, method = 'GET') => {
    calls.push({ path, method }); const url = new URL(path, 'http://test.invalid');
    if (url.pathname === '/agent/skills') return installed;
    if (url.pathname === '/skill-market/markets') return [{ name: 'community' }];
    if (url.pathname === '/skill-market/proxy') return [{ slug: 'author/code-review', displayName: '代码审查', summary: '检查代码质量', url: marketUrl }];
    if (url.pathname === '/skill-market/detail') return { slug: 'author/code-review', installSlug: 'code-review', displayName: '代码审查', description: '完整技能文档' };
    if (url.pathname === '/skill-market/install') { if (failInstall) throw new Error('安装失败，请重试'); installed = [...installed, { name: url.searchParams.get('slug'), description: '新技能' }]; return 'ok'; }
    if (url.pathname === '/skill-market/uninstall') { installed = installed.filter(skill => skill.name !== url.searchParams.get('slug')); return null; }
    throw new Error(`Unexpected ${path}`);
  }};
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  await act(async () => root.render(createElement(SkillsPage, { api, onRefresh: async () => { refreshes++; }, onBack: () => { backs++; } })));
  return { container, calls, get refreshes() { return refreshes; }, get backs() { return backs; }, async close() { await act(async () => root.unmount()); container.remove(); } };
}
test('installed skills filter locally, expose full details and return to the conversation', async () => {
  const view = await mount();
  try {
    assert.equal(view.container.querySelectorAll('.skills-hub-card').length, 2);
    await input(view.container.querySelector('input'), 'ego');
    assert.equal(view.container.querySelectorAll('.skills-hub-card').length, 1);
    await click(button(view.container.querySelector('.skills-hub-card'), '查看详情'));
    assert.equal(view.container.querySelector('[role="dialog"] .skills-detail-description').textContent, '浏览器自动化');
    assert.equal(view.container.querySelector('[role="dialog"] a'), null, 'local skills without a source must not invent a website');
    assert.ok(!view.calls.some(call => call.path.startsWith('/skill-market/detail')));
    await click(view.container.querySelector('[aria-label="关闭技能详情"]'));
    await click(button(view.container, '返回会话')); assert.equal(view.backs, 1);
  } finally { await view.close(); }
});
test('market search and detail install preserve the market and canonical install slug', async () => {
  const view = await mount();
  try {
    await click(button(view.container, '技能市场'));
    assert.ok(view.calls.some(call => call.path.includes('action=trending')));
    const select = view.container.querySelector('select');
    await act(async () => { select.value = 'community'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
    await input(view.container.querySelector('input'), '代码');
    await act(async () => view.container.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
    const request = new URL(view.calls.findLast(call => call.path.startsWith('/skill-market/proxy')).path, 'http://test.invalid');
    assert.equal(request.searchParams.get('q'), '代码'); assert.equal(request.searchParams.get('marketName'), 'community');
    await click(button(view.container.querySelector('.skills-hub-card'), '查看详情'));
    assert.equal(view.container.querySelector('[role="dialog"] .skills-detail-description').textContent, '完整技能文档');
    const website = view.container.querySelector('[role="dialog"] .skills-detail-website');
    assert.equal(website.href, 'https://skillhub.cn/skills/author/code-review', 'the list source URL survives a detail response without a URL');
    assert.equal(website.target, '_blank');
    assert.equal(website.rel, 'noopener noreferrer');
    await click(button(view.container, '安装此技能'));
    assert.ok(view.calls.some(call => call.method === 'POST' && call.path === '/skill-market/install?slug=code-review&marketName=community'));
    assert.equal(view.refreshes, 1);
    assert.equal(button(view.container.querySelector('[role="dialog"]'), '已安装').disabled, true);
  } finally { await view.close(); }
});
test('uninstall requires confirmation and refreshes installed skills', async () => {
  const view = await mount();
  try {
    await click(button(view.container.querySelector('.skills-hub-card'), '卸载'));
    assert.ok(!view.calls.some(call => call.method === 'POST'));
    await click(button(view.container.querySelector('[role="dialog"]'), '确认'));
    assert.ok(view.calls.some(call => call.path === '/skill-market/uninstall?slug=self-skill' && call.method === 'POST'));
    assert.equal(view.container.querySelectorAll('.skills-hub-card').length, 1); assert.equal(view.refreshes, 1);
  } finally { await view.close(); }
});
test('failed installs display the server error and leave installed skills unchanged', async () => {
  const view = await mount({ failInstall: true });
  try {
    await click(button(view.container, '技能市场'));
    await click(button(view.container.querySelector('.skills-hub-card'), '安装'));
    assert.match(view.container.querySelector('[role="alert"]').textContent, /安装失败/);
    assert.equal(view.refreshes, 0);
    await click(button(view.container, '已安装2'));
    assert.equal(view.container.querySelectorAll('.skills-hub-card').length, 2);
  } finally { await view.close(); }
});
test('skill details hide invalid source links', async () => {
  const view = await mount({ marketUrl: 'javascript:alert(1)' });
  try {
    await click(button(view.container, '技能市场'));
    await click(button(view.container.querySelector('.skills-hub-card'), '查看详情'));
    assert.equal(view.container.querySelector('[role="dialog"] a'), null);
  } finally { await view.close(); }
});
