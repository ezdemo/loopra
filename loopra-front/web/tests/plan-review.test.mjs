import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// The plan-review band mirrors legacy Chat.vue: both the plan-mode toggle and the
// band exit button funnel into the same confirm-then-exit flow, and a submitted
// plan is shown with an "approve & run" action.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const reactUrl = import.meta.resolve('react');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
async function sourceUrl(name, dependencies = {}) {
  const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
  for (const [specifier, url] of Object.entries({ react: reactUrl, 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), ...dependencies })) {
    outputText = outputText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
  }
  return dataUrl(outputText);
}

const nextuiStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const Button = ({ children, onPress, isDisabled, startContent, ...rest }) => createElement('button', { type: 'button', disabled: !!isDisabled, onClick: onPress, ...rest }, startContent, children);
`);
const iconsStub = dataUrl('export const Check=()=>null;export const ChevronDown=()=>null;export const FileText=()=>null;export const X=()=>null;');
const motionStub = dataUrl(`export const Collapse = ({ open, children }) => open ? children : null;`);
const markdownStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export default ({ text }) => createElement('div', { className: 'md-stub' }, text);
`);

const { default: PlanReview } = await import(await sourceUrl('components/PlanReview.tsx', {
  '@nextui-org/react': nextuiStub, 'lucide-react': iconsStub, './Motion': motionStub, './Markdown': markdownStub, './Markdown.tsx': markdownStub,
}));

function render(props) {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(PlanReview, { notify: () => {}, ...props })));
  return { container, root, unmount: () => act(() => root.unmount()) };
}

test('shows the read-only state and no approve action without a pending plan', () => {
  const view = render({ busy: false, onApprove: () => {}, onExit: () => {} });
  try {
    assert.match(view.container.textContent, /计划模式/);
    assert.match(view.container.textContent, /只读探索/);
    assert.doesNotMatch(view.container.textContent, /待审查/);
    assert.equal(view.container.querySelector('.plan-approve-btn'), null);
  } finally { view.unmount(); }
});

test('shows a submitted plan with an approve action', () => {
  const view = render({ pendingPlan: '# 待执行计划\n\n- 打开文件', busy: false, onApprove: () => {}, onExit: () => {} });
  try {
    assert.match(view.container.textContent, /待审查/);
    assert.match(view.container.textContent, /待执行计划/);
    assert.match(view.container.textContent, /批准并执行/);
  } finally { view.unmount(); }
});

test('approve triggers execution and exit triggers the confirm flow', () => {
  const approves = []; const exits = [];
  const view = render({ pendingPlan: '计划内容', busy: false, onApprove: () => approves.push(true), onExit: () => exits.push(true) });
  try {
    act(() => view.container.querySelector('.plan-approve-btn').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    act(() => view.container.querySelector('.plan-exit-btn').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    assert.equal(approves.length, 1);
    assert.equal(exits.length, 1);
  } finally { view.unmount(); }
});

test('busy disables both approve and exit while a run is active', () => {
  const view = render({ pendingPlan: '计划内容', busy: true, onApprove: () => {}, onExit: () => {} });
  try {
    assert.equal(view.container.querySelector('.plan-approve-btn').disabled, true);
    assert.equal(view.container.querySelector('.plan-exit-btn').disabled, true);
  } finally { view.unmount(); }
});
