import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const source = await readFile(new URL('../src/i18n.ts', import.meta.url), 'utf8');
const zhPart = source.split('const zh = {', 2)[1]?.split('const en:', 2)[0] || '';
const enPart = source.split('const en:', 2)[1] || '';
const keys = text => new Set([...text.matchAll(/^\s*'([^']+)':/gm)].map(match => match[1]));
const zhKeys = keys(zhPart);
const enKeys = keys(enPart);

test('zh and en i18n resources expose the same keys', () => {
  assert.deepEqual([...zhKeys].filter(key => !enKeys.has(key)).sort(), []);
  assert.deepEqual([...enKeys].filter(key => !zhKeys.has(key)).sort(), []);
  assert.ok(zhKeys.size > 100);
});

test('core language switching keys are present', () => {
  for (const key of ['nav.newChat', 'settings.language', 'composer.sendMessage', 'chat.copyReply']) {
    assert.ok(zhKeys.has(key), `${key} missing from zh resources`);
    assert.ok(enKeys.has(key), `${key} missing from en resources`);
  }
});


test('mounted controls and the document language update when the app language changes', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  try {
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
      .replaceAll("'i18next'", JSON.stringify(import.meta.resolve('i18next')))
      .replaceAll("'react-i18next'", JSON.stringify(import.meta.resolve('react-i18next')));
    const module = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
    const { act, createElement } = await import('react');
    const { useTranslation } = await import('react-i18next');
    const { createRoot } = await import('react-dom/client');
    function Probe() {
      const { t } = useTranslation();
      return createElement('button', null, t('nav.newChat'));
    }
    const host = dom.window.document.createElement('div');
    dom.window.document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(Probe)));
    await act(async () => { await module.setAppLanguage('zh'); });
    assert.equal(host.textContent, '新建会话');
    assert.equal(dom.window.document.documentElement.lang, 'zh-CN');
    await act(async () => { await module.setAppLanguage('en'); });
    assert.equal(host.textContent, 'New chat');
    assert.equal(dom.window.document.documentElement.lang, 'en');
    await act(async () => { await module.setAppLanguage('zh'); });
    assert.equal(host.textContent, '新建会话');
    assert.equal(dom.window.document.documentElement.lang, 'zh-CN');
    await act(async () => root.unmount());
  } finally {
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  }
});
