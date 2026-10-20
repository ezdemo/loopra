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

const reactUrl = import.meta.resolve('react');
const { act, createElement } = await import(reactUrl);
const { createRoot } = await import('react-dom/client');
const dataUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const composer = await readFile(new URL('../src/composer.ts', import.meta.url), 'utf8');
const scale = composer.match(/export const effortLevels = \[[\s\S]*?\n\];/)[0];
const controls = dataUrl(`import { createElement } from ${JSON.stringify(reactUrl)};
export const Slider = ({ value, isDisabled, className }) => createElement('div', { className, 'data-value': value, 'data-disabled': isDisabled });
export const Input = () => null;
export const Button = ({ children, ...props }) => createElement('button', props, children);`);
const source = await readFile(new URL('../src/components/ReasoningControl.tsx', import.meta.url), 'utf8');
let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
for (const [specifier, url] of Object.entries({ react: reactUrl, 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), '@nextui-org/react': controls, 'lucide-react': dataUrl('export const Brain = () => null;'), '../composer': dataUrl(scale) })) {
  outputText = outputText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
}
const { default: ReasoningControl } = await import(dataUrl(outputText));

test('selected reasoning stays visible while saving, including stale-value and busy renders', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let finish;
  const props = { value: 'low', disabled: false, allowCustom: false, onClose: () => {}, onCommit: () => new Promise(resolve => { finish = resolve; }) };
  const render = async next => act(async () => root.render(createElement(ReasoningControl, { ...props, ...next })));
  try {
    await render({});
    const slider = host.querySelector('.effort-range');
    await act(async () => host.querySelector('[aria-label="推理强度：最大"]').click());
    assert.equal(host.querySelector('.effort-summary strong').textContent, '最大强度');
    await render({ disabled: true });
    assert.equal(host.querySelector('.effort-summary strong').textContent, '最大强度');
    assert.equal(host.querySelector('.effort-range').dataset.value, '5');
    assert.equal(host.querySelector('.effort-range'), slider, 'saving must not remount the slider');
    await render({ value: 'max' });
    await act(async () => finish());
    assert.equal(host.querySelector('.effort-summary strong').textContent, '最大强度');
    assert.equal(host.querySelector('[aria-label="推理强度：最大"]').getAttribute('aria-pressed'), 'true');
  } finally { await act(async () => root.unmount()); host.remove(); }
});
