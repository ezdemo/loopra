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
  for (const [name, url] of Object.entries({ 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), ...dependencies })) outputText = outputText.replaceAll(`'${name}'`, JSON.stringify(url)).replaceAll(`"${name}"`, JSON.stringify(url));
  return dataUrl(outputText);
}
const react = import.meta.resolve('react');
const { default: Hub } = await import(await compile('components/SkillsAndPluginsPage.tsx', {
  '@nextui-org/react': dataUrl(`import {createElement as h} from ${JSON.stringify(react)}; export const Button = ({children, onPress}) => h('button', {onClick:onPress}, children);`),
  './SkillsPage': dataUrl(`import {createElement as h} from ${JSON.stringify(react)}; export default ({embedded, onRefresh}) => h('button', {onClick:onRefresh, 'data-skills':embedded}, '技能列表');`),
  './ResourceManagers': dataUrl(`import {createElement as h} from ${JSON.stringify(react)}; export const ExtensionManager = ({embedded, onChanged, context}) => h('button', {onClick:onChanged, 'data-plugins':embedded, 'data-session':context?.sessionId}, '安装插件');`),
}));
const { capabilitiesTabForSection } = await import(await compile('capabilities-navigation.ts'));

test('one hub switches between skills and plugins while preserving refresh and page context', async () => {
  let refreshes = 0, changes = 0, backs = 0;
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  function View() {
    const [tab, onTabChange] = useState('skills');
    return h(Hub, { api: {}, tab, onTabChange, context: { sessionId: 'project/session' }, onRefresh: async () => { refreshes++; }, onPluginsChanged: () => { changes++; }, onBack: () => { backs++; } });
  }
  const click = text => act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === text).click());
  try {
    await act(async () => root.render(h(View)));
    assert.equal(container.querySelector('h1').textContent, '技能与插件');
    assert.equal(container.querySelector('[data-skills]').getAttribute('data-skills'), 'true');
    await click('技能列表'); assert.equal(refreshes, 1);
    await click('插件');
    assert.equal(container.querySelector('[data-skills]'), null);
    assert.equal(container.querySelector('[data-plugins]').getAttribute('data-session'), 'project/session');
    await click('安装插件'); assert.equal(changes, 1);
    await click('技能'); assert.ok(container.querySelector('[data-skills]'));
    await click('返回会话'); assert.equal(backs, 1);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

test('legacy plugin shortcuts open the plugin tab in the unified hub', () => {
  for (const section of ['插件', '拓展包', 'OpenAPI']) assert.equal(capabilitiesTabForSection(section), 'plugins');
  for (const section of ['技能', '技能与插件']) assert.equal(capabilitiesTabForSection(section), 'skills');
  assert.equal(capabilitiesTabForSection('服务器'), undefined);
});
