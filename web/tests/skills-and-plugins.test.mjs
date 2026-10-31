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
const { act, createElement: h, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
async function compile(file, dependencies = {}) {
  const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
  for (const [name, url] of Object.entries({ react: import.meta.resolve('react'), 'react-dom': import.meta.resolve('react-dom'), 'lucide-react': import.meta.resolve('lucide-react'), 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), ...dependencies })) outputText = outputText.replaceAll(`'${name}'`, JSON.stringify(url)).replaceAll(`"${name}"`, JSON.stringify(url));
  return dataUrl(outputText);
}
const react = import.meta.resolve('react');
const { default: Hub } = await import(await compile('components/SkillsAndPluginsPage.tsx', {
  'react': react,
  'lucide-react': import.meta.resolve('lucide-react'),
  './CapabilityUI': await compile('components/CapabilityUI.tsx'),
  '@nextui-org/react': dataUrl(`import {createElement as h} from ${JSON.stringify(react)}; export const Button = ({children, onPress}) => h('button', {onClick:onPress}, children); export const Spinner = () => h('span', {'data-spinner':true});`),
  './SkillsPage': dataUrl(`import {createElement as h} from ${JSON.stringify(react)}; export default ({embedded, onRefresh, view, refreshKey, installedRefreshKey}) => h('button', {onClick:onRefresh, 'data-skills':embedded, 'data-view':view, 'data-refresh':refreshKey, 'data-installed-refresh':installedRefreshKey}, '技能列表');`),
  './ResourceManagers': dataUrl(`import {createElement as h} from ${JSON.stringify(react)}; export const ExtensionManager = ({embedded, onChanged, context, view, refreshKey}) => h('button', {onClick:onChanged, 'data-plugins':embedded, 'data-view':view, 'data-refresh':refreshKey, 'data-session':context?.sessionId}, '安装插件');`),
}));
const { capabilitiesTabForSection } = await import(await compile('capabilities-navigation.ts'));

test('one hub switches between skills and plugins while preserving refresh and page context', async () => {
  let refreshes = 0, changes = 0, backs = 0;
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  function View() {
    const [tab, onTabChange] = useState('all');
    return h(Hub, { api: {}, tab, onTabChange, context: { sessionId: 'project/session' }, onRefresh: async () => { refreshes++; }, onPluginsChanged: () => { changes++; }, onBack: () => { backs++; } });
  }
  const click = text => act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === text || button.getAttribute('aria-label') === text).click());
  try {
    await act(async () => root.render(h(View)));
    assert.equal(container.querySelector('h1').textContent, '技能与插件');
    assert.deepEqual([...container.querySelectorAll('nav button')].map(button => button.textContent), ['我的内容', '发现']);
    assert.ok(container.querySelector('[data-plugins]'));
    assert.equal(container.querySelector('[data-skills]').getAttribute('data-skills'), 'true');
    await click('技能列表'); assert.equal(refreshes, 1);
    assert.equal(container.querySelector('[data-skills]').getAttribute('data-refresh'), '0');
    assert.equal(container.querySelector('[data-plugins]').getAttribute('data-refresh'), '0');
    await act(async () => container.querySelector('[data-plugins]').click());
    assert.equal(container.querySelector('[data-skills]').getAttribute('data-installed-refresh'), '1');
    assert.equal(container.querySelector('[data-skills]').getAttribute('data-refresh'), '0');
    assert.equal(container.querySelector('[data-plugins]').getAttribute('data-refresh'), '0');
    await click('刷新');
    assert.equal(container.querySelector('[data-skills]').getAttribute('data-refresh'), '1');
    assert.equal(container.querySelector('[data-plugins]').getAttribute('data-refresh'), '1');
    await click('插件');
    assert.equal(container.querySelector('[data-skills]'), null);
    assert.equal(container.querySelector('[data-plugins]').getAttribute('data-session'), 'project/session');
    await act(async () => container.querySelector('[data-plugins]').click()); assert.equal(changes, 2);
    await click('发现'); assert.equal(container.querySelector('[data-plugins]').getAttribute('data-view'), 'catalog');
    await click('技能'); assert.equal(container.querySelector('[data-skills]').getAttribute('data-view'), 'market');
    await click('我的内容'); await click('全部'); assert.ok(container.querySelector('[data-skills]')); assert.ok(container.querySelector('[data-plugins]'));
    await click('返回会话'); assert.equal(backs, 1);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

test('legacy plugin shortcuts open the plugin tab in the unified hub', () => {
  for (const section of ['插件', '拓展包', 'OpenAPI']) assert.equal(capabilitiesTabForSection(section), 'plugins');
  assert.equal(capabilitiesTabForSection('技能'), 'skills');
  assert.equal(capabilitiesTabForSection('技能与插件'), 'all');
  assert.equal(capabilitiesTabForSection('服务器'), undefined);
});
