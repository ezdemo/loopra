import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const intersections = [], resizes = [];
const globals = {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
  IntersectionObserver: class {
    constructor(callback) { this.callback = callback; intersections.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
  },
  ResizeObserver: class {
    constructor(callback) { this.callback = callback; resizes.push(this); }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
  },
};
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => {
  dom.window.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const reactUrl = import.meta.resolve('react');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
async function sourceUrl(name, dependencies = {}) {
  const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
  for (const [specifier, url] of Object.entries({ react: reactUrl, 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), 'lucide-react': import.meta.resolve('lucide-react'), ...dependencies })) {
    outputText = outputText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
  }
  return dataUrl(outputText);
}
const ui = dataUrl(`
  import { createElement, forwardRef, useState } from ${JSON.stringify(reactUrl)};
  export const Button = ({ children, onPress }) => createElement('button', { onClick: onPress }, children);
  export const Select = forwardRef(({ onOpenChange, popoverProps, 'aria-label': label }, ref) => {
    const [open, setOpen] = useState(false);
    return createElement('div', { 'data-slot': 'base', 'data-popover-width': popoverProps?.style?.width },
      createElement('select', { ref }),
      createElement('button', { 'data-slot': 'trigger', onClick: () => { setOpen(!open); onOpenChange(!open); } }, label));
  });
  export const Accordion = () => null, AccordionItem = () => null, Input = () => null,
    SelectItem = () => null, SelectSection = () => null, Switch = () => null,
    Tab = () => null, Tabs = () => null, Textarea = () => null;
`);
const motion = dataUrl('export const useAppMotion = () => ({ enabled: false });');
const controlsUrl = await sourceUrl('components/SettingControls.tsx', { '@nextui-org/react': ui, './Motion': motion });
const { SelectField } = await import(controlsUrl);
const petsUrl = await sourceUrl('pets.ts');
const spriteUrl = await sourceUrl('components/PetSprite.tsx', { '../pets': petsUrl, './Motion': motion });
const { default: PetSprite } = await import(spriteUrl);
const { default: PetSettings } = await import(await sourceUrl('components/PetSettings.tsx', {
  '@nextui-org/react': ui, '../pets': petsUrl, './SettingControls': controlsUrl, './PetSprite': spriteUrl,
  './RemoteControls': dataUrl('export const ConfirmAction = () => null;'),
}));

async function mount(Component, props) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Component, props)));
  return {
    container,
    async click(element) { await act(async () => element.click()); },
    async close() { await act(async () => root.unmount()); container.remove(); },
  };
}

test('settings selects measure only when opened, keep their width current and release observers on close', async () => {
  let reads = 0, width = 240;
  const descriptor = Object.getOwnPropertyDescriptor(dom.window.HTMLElement.prototype, 'offsetWidth');
  Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { reads++; return width; } });
  const view = await mount(SelectField, { label: 'Application', compact: true, value: 'Explorer', options: ['Explorer'], onChange() {} });
  try {
    assert.equal(reads, 0, 'mounting settings must not force select layout');
    const trigger = view.container.querySelector('button');
    await view.click(trigger);
    assert.equal(reads, 1);
    assert.equal(view.container.firstElementChild.dataset.popoverWidth, '240');
    const observer = resizes.at(-1);
    width = 320;
    await act(async () => observer.callback());
    assert.equal(view.container.firstElementChild.dataset.popoverWidth, '320');
    await view.click(trigger);
    assert.equal(observer.disconnected, true);
  } finally {
    await view.close();
    Object.defineProperty(dom.window.HTMLElement.prototype, 'offsetWidth', descriptor);
  }
});

test('offscreen pet previews wait for intersection before requesting their atlas', async () => {
  const view = await mount(PetSprite, { lazy: true, name: 'Preview', src: '/sprite.png' });
  try {
    assert.equal(view.container.querySelector('img'), null);
    const observer = intersections.at(-1);
    await act(async () => observer.callback([{ isIntersecting: true }]));
    const image = view.container.querySelector('img');
    assert.equal(image.getAttribute('src'), '/sprite.png');
    assert.equal(image.getAttribute('decoding'), 'async');
    await act(async () => observer.callback([{ isIntersecting: false }]));
    assert.equal(view.container.querySelector('img'), image, 'scrolling away retains the loaded atlas');
    await view.close();
    assert.equal(observer.disconnected, true);
  } catch (error) { await view.close(); throw error; }
});

test('opening pet settings uses the existing store, while explicit refresh remains available', async () => {
  let refreshes = 0;
  const view = await mount(PetSettings, { pets: { pets: [], active: null, loading: false, refresh: async () => { refreshes++; } }, enabled: false, onEnabled() {}, notify() {} });
  try {
    assert.equal(refreshes, 0);
    await view.click([...view.container.querySelectorAll('button')].find(button => button.textContent === '刷新宠物列表'));
    assert.equal(refreshes, 1);
  } finally { await view.close(); }
});
