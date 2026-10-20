import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// The input-tool menu sits inside the chat pane, whose overflow-hidden box
// starts below the header. This regression covers the same clipped-bounds and
// measured-height rules as the project selector, with the composer's toolbar
// offset. The menu body scrolls while its heading remains visible.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });

const reactUrl = import.meta.resolve('react');
const { act, createElement, useRef } = await import(reactUrl);
const { createRoot } = await import('react-dom/client');
const source = await readFile(new URL('../src/layout/menu-placement.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const placementUrl = 'data:text/javascript;base64,' + Buffer.from(outputText.replaceAll("'react'", JSON.stringify(reactUrl))).toString('base64');
const { useMenuPlacement } = await import(placementUrl);

function Harness() {
  const anchorRef = useRef(null);
  const placement = useMenuPlacement(true, anchorRef, { offsetRem: 4.375 });
  return createElement('div', {
    ref: anchorRef,
    className: 'composer-anchor',
    'data-side': placement.side,
    style: { '--menu-max-height': `${placement.maxHeight}px` },
  }, createElement('div', { className: 'composer-popover' }));
}

const rectOf = ({ top, bottom }) => ({ top, bottom, left: 0, right: 800, width: 800, height: bottom - top, x: 0, y: top, toJSON() {} });

async function mount(anchor, bounds) {
  Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: 640 });
  const original = dom.window.Element.prototype.getBoundingClientRect;
  dom.window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.classList?.contains('composer-anchor')) return rectOf(anchor);
    if (this.classList?.contains('clip-pane')) return rectOf(bounds);
    return rectOf({ top: 0, bottom: 640 });
  };
  const host = document.createElement('div');
  host.className = 'clip-pane';
  host.style.overflow = 'hidden';
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(Harness)));
  } finally {
    dom.window.Element.prototype.getBoundingClientRect = original;
  }
  return {
    anchor: host.querySelector('.composer-anchor'),
    async close() { await act(async () => root.unmount()); host.remove(); },
  };
}

test('the composer menu measures above its toolbar offset inside the clipped pane', async () => {
  const view = await mount({ top: 450, bottom: 600 }, { top: 48, bottom: 640 });
  try {
    assert.equal(view.anchor.dataset.side, 'top');
    assert.equal(view.anchor.style.getPropertyValue('--menu-max-height'), '474px');
  } finally { await view.close(); }
});

test('the composer menu flips below only when the measured space above is unusable', async () => {
  const view = await mount({ top: 40, bottom: 120 }, { top: 0, bottom: 640 });
  try {
    assert.equal(view.anchor.dataset.side, 'bottom');
    // The downward CSS gap is still 7px even though the up direction starts at
    // the toolbar-offset edge with no additional gap.
    assert.equal(view.anchor.style.getPropertyValue('--menu-max-height'), '505px');
  } finally { await view.close(); }
});

function ruleBody(css, selector) {
  const pattern = new RegExp('^[ \\t]*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]*)\\}', 'm');
  const match = css.match(pattern);
  assert.ok(match, `missing CSS rule: ${selector}`);
  return match[1];
}

test('composer menus cap the popup and scroll the body under a fixed heading', async () => {
  const component = await readFile(new URL('../src/components/Composer.tsx', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../src/composer.css', import.meta.url), 'utf8');
  assert.match(component, /useMenuPlacement\(!!menu, root, \{ offsetRem: 4\.375 \}\)/);
  assert.match(component, /data-placement=\{menuPlacement\.side\}/);
  assert.match(component, /--composer-popover-max-height/);

  const popover = ruleBody(styles, '.composer-popover');
  assert.match(popover, /max-height:\s*min\(37\.5rem,\s*var\(--composer-popover-max-height/);
  assert.match(popover, /overflow:\s*hidden/);
  assert.match(popover, /display:\s*flex/);
  assert.match(ruleBody(styles, '.composer-popover > section'), /min-height:\s*0/);
  assert.match(ruleBody(styles, '.composer-popover-header'), /flex:\s*0 0 auto/);
  assert.match(ruleBody(styles, '.composer-tool-list'), /overflow-y:\s*auto/);
  assert.match(ruleBody(styles, '.rich-composer[data-placement="bottom"] > .composer-popover'), /top:\s*calc\(100% \+ 0\.4375rem\)/);
});
