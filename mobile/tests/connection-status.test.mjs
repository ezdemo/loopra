import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';
import { load } from './load-source.mjs';

const { JSDOM } = createRequire(new URL('../../web/package.json', import.meta.url))('jsdom');
const dom = new JSDOM('<html><body></body></html>', { url: 'http://test.invalid' });
const globals = {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  HTMLButtonElement: dom.window.HTMLButtonElement, SVGElement: dom.window.SVGElement,
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
  IS_REACT_ACT_ENVIRONMENT: true,
};
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (/^(HTML.*Element|SVG.*Element|Document|DocumentFragment|ShadowRoot|NodeFilter|.*Event)$/.test(key)) globals[key] = dom.window[key];
}
const errors = [];
dom.virtualConsole.on('jsdomError', error => errors.push(error));
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: Status } = await load('components/MobileConnectionStatus.tsx');

test('reconnect feedback stays visible during automatic recovery, blocks repeated taps and confirms recovery', async () => {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  let clicks = 0;
  const update = props => act(() => root.render(createElement(Status, { error: '', onReconnect: () => { clicks++; }, ...props })));
  try {
    update({ online: true, reconnecting: false, busy: false });
    assert.equal(container.textContent, '');
    update({ online: false, reconnecting: true, busy: false });
    assert.match(container.textContent, /正在重新连接/);
    assert.equal(container.querySelector('[role="status"]').getAttribute('aria-live'), 'polite');
    await act(async () => container.querySelector('button').click());
    assert.equal(clicks, 1);
    update({ online: false, reconnecting: true, busy: true });
    assert.equal(container.querySelector('button').disabled, true);
    await act(async () => container.querySelector('button').click());
    assert.equal(clicks, 1);
    update({ online: true, reconnecting: false, busy: false });
    assert.match(container.textContent, /连接已恢复/);
    await act(async () => new Promise(resolve => setTimeout(resolve, 2450)));
    assert.equal(container.textContent, '');
    update({ online: true, reconnecting: false, busy: false, result: 1 });
    assert.match(container.textContent, /连接正常/);
    update({ online: true, reconnecting: true, busy: true });
    assert.match(container.textContent, /正在检查连接/);
    update({ online: true, reconnecting: false, busy: false });
    assert.match(container.textContent, /连接正常/);
    update({ online: false, reconnecting: false, busy: false, error: '请扫描当前配对码' });
    assert.match(container.textContent, /请扫描当前配对码/);
    assert.doesNotMatch(container.textContent, /连接正常/);
    assert.deepEqual(errors, []);
  } finally { await act(async () => root.unmount()); container.remove(); }
});
