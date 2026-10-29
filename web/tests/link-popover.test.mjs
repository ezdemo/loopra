import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// External links always offer the browser action, including under Electron.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const pureSource = await readFile(new URL('../src/link-popover.ts', import.meta.url), 'utf8');
const pureText = ts.transpileModule(pureSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const pureUrl = 'data:text/javascript;base64,' + Buffer.from(pureText).toString('base64');
const { LINK_POPOVER_HIDE_DELAY_MS, linkPopoverPosition, normalizeActionUrl } = await import(pureUrl);

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const reactUrl = import.meta.resolve('react');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');

const componentSource = await readFile(new URL('../src/components/LinkPopover.tsx', import.meta.url), 'utf8');
let componentText = ts.transpileModule(componentSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
for (const [specifier, url] of Object.entries({
  react: reactUrl,
  'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'),
  'react-dom': import.meta.resolve('react-dom'),
  'lucide-react': import.meta.resolve('lucide-react'),
  '../link-popover': pureUrl,
})) {
  componentText = componentText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
}
const { LinkPopoverProvider, useLinkPopover } = await import(dataUrl(componentText));
after(() => {
  dom.window.close();
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
});

// A link wired exactly like Markdown.tsx wires external anchors.
function Harness({ href, filePath }) {
  const { show, scheduleHide } = useLinkPopover();
  return createElement('a', {
    className: 'ai-link',
    href,
    'data-file-path': filePath,
    onMouseEnter: event => show(event.currentTarget),
    onMouseLeave: scheduleHide,
  }, '链接');
}

async function mount(props) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(LinkPopoverProvider, null, createElement(Harness, props))));
  return {
    link: () => container.querySelector('a'),
    popovers: () => [...document.querySelectorAll('.link-popover')],
    buttons: () => [...document.querySelectorAll('.link-popover-btn')].map(button => button.textContent),
    async hover() { await act(async () => { container.querySelector('a').dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })); }); },
    async click(text) {
      const button = [...document.querySelectorAll('.link-popover-btn')].find(item => item.textContent === text);
      await act(async () => { button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    },
    async close() { await act(async () => root.unmount()); container.remove(); document.querySelectorAll('.link-popover').forEach(node => node.remove()); },
  };
}

test('normalizeActionUrl trims punctuation and rejects non-http links', () => {
  // Legacy regex treats `?` as trailing punctuation, so query strings are dropped.
  assert.equal(normalizeActionUrl('https://example.com/a?b=1'), 'https://example.com/a');
  assert.equal(normalizeActionUrl('https://example.com/docs。'), 'https://example.com/docs');
  assert.equal(normalizeActionUrl('HTTP://Example.com/x'), 'http://example.com/x');
  // The legacy pattern is anchored, so prose+citation hrefs are ignored.
  assert.equal(normalizeActionUrl('见 https://example.com/docs'), '');
  assert.equal(normalizeActionUrl('ftp://example.com'), '');
  assert.equal(normalizeActionUrl('javascript:alert(1)'), '');
  assert.equal(normalizeActionUrl(''), '');
  assert.equal(normalizeActionUrl(undefined), '');
});

test('linkPopoverPosition centers under the link and clamps to the viewport', () => {
  assert.deepEqual(linkPopoverPosition({ left: 300, width: 100, bottom: 20 }, 1280), { x: 350, y: 24 });
  assert.deepEqual(linkPopoverPosition({ left: 0, width: 10, bottom: 5 }, 1280), { x: 80, y: 9 });
  assert.deepEqual(linkPopoverPosition({ left: 1270, width: 10, bottom: 5 }, 1280), { x: 1200, y: 9 });
  assert.equal(LINK_POPOVER_HIDE_DELAY_MS, 150);
});

test('hovering an external link opens the browser toolbar', async () => {
  const view = await mount({ href: 'https://example.com/docs' });
  assert.equal(view.popovers().length, 0);
  await view.hover();
  assert.equal(view.popovers().length, 1);
  assert.deepEqual(view.buttons(), ['浏览器打开']);
  const opened = [];
  dom.window.open = url => { opened.push(url); return null; };
  await view.click('浏览器打开');
  assert.deepEqual(opened, ['https://example.com/docs']);
  assert.equal(view.popovers().length, 0, '选择后浮层关闭');
  await view.close();
});

test('workspace file links and unusable hrefs never show the toolbar', async () => {
  const file = await mount({ href: '#', filePath: 'src/app.ts' });
  await file.hover();
  assert.equal(file.popovers().length, 0);
  await file.close();

  const bare = await mount({ href: 'not-a-url' });
  await bare.hover();
  assert.equal(bare.popovers().length, 0);
  await bare.close();
});

test('Electron links use the default browser without the element window option', async () => {
  const calls = [];
  dom.window.electronAPI = {
    openExternal: async url => { calls.push(['external', url]); },
    elementInspectorWindow: { open: async url => { calls.push(['element', url]); } },
  };
  const view = await mount({ href: 'https://example.com/panel' });
  await view.hover();
  assert.deepEqual(view.buttons(), ['浏览器打开']);
  await view.click('浏览器打开');
  assert.deepEqual(calls, [['external', 'https://example.com/panel']]);
  delete dom.window.electronAPI;
  await view.close();
});

test('without the browser bridge links use window.open and never dispatch an element-window event', async () => {
  const events = [];
  const opened = [];
  dom.window.open = url => { opened.push(url); return null; };
  const listener = event => events.push(event.detail);
  dom.window.addEventListener('loopra:open-in-element', listener);
  dom.window.electronAPI = { elementInspectorWindow: {} };
  const view = await mount({ href: 'https://example.com/event' });
  await view.hover();
  await view.click('浏览器打开');
  dom.window.removeEventListener('loopra:open-in-element', listener);
  assert.deepEqual(events, []);
  assert.deepEqual(opened, ['https://example.com/event']);
  delete dom.window.electronAPI;
  await view.close();
});
