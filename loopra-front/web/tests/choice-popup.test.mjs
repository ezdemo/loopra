import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// Pending HITL/ask_choice cards are answered above the composer. One question
// submits directly; several are stepped through (下一个) before a final 提交.
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
const iconsStub = dataUrl('export const Check=()=>null;export const ChevronLeft=()=>null;export const CircleHelp=()=>null;');

const { default: ChoicePopup } = await import(await sourceUrl('components/ChoicePopup.tsx', { '@nextui-org/react': nextuiStub, 'lucide-react': iconsStub }));

const approval = { id: 'c1', type: 'choice', question: 'bash 需要审批', options: [{ title: '同意执行', value: '/agree' }, { title: '拒绝执行', value: '/deny' }] };
const second = { id: 'c2', type: 'choice', question: '接下来？', options: [{ title: '继续', value: '继续' }, { title: '停止', value: '停止' }] };

function render(props) {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(ChoicePopup, props)));
  return { container, unmount: () => act(() => root.unmount()) };
}
const click = (node) => act(() => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));

test('a single question submits the picked value and stays disabled until picked', () => {
  const answers = [];
  const view = render({ choices: [approval], onSubmit: value => answers.push(value) });
  try {
    assert.match(view.container.textContent, /bash 需要审批/);
    assert.doesNotMatch(view.container.textContent, /问题 1 \/ 1/);
    assert.equal(view.container.querySelector('.choice-submit').disabled, true);
    click(view.container.querySelectorAll('.choice-popup-option')[0]);
    assert.equal(view.container.querySelector('.choice-submit').disabled, false);
    click(view.container.querySelector('.choice-submit'));
    assert.deepEqual(answers, [[{ id: 'c1', value: '/agree', label: '同意执行', subId: undefined }]]);
  } finally { view.unmount(); }
});

test('several questions step with 下一个 and submit every answer in order', () => {
  const answers = [];
  const view = render({ choices: [approval, second], onSubmit: value => answers.push(value) });
  try {
    assert.match(view.container.textContent, /问题 1 \/ 2/);
    // 下一个 is disabled until the first question is answered.
    assert.equal(view.container.querySelector('.choice-next').disabled, true);
    click(view.container.querySelectorAll('.choice-popup-option')[1]);
    click(view.container.querySelector('.choice-next'));
    assert.match(view.container.textContent, /问题 2 \/ 2/);
    click(view.container.querySelectorAll('.choice-popup-option')[0]);
    click(view.container.querySelector('.choice-submit'));
    assert.deepEqual(answers[0], [
      { id: 'c1', value: '/deny', label: '拒绝执行', subId: undefined },
      { id: 'c2', value: '继续', label: '继续', subId: undefined },
    ]);
  } finally { view.unmount(); }
});

test('an empty choices list renders nothing', () => {
  const view = render({ choices: [], onSubmit: () => {} });
  try { assert.equal(view.container.querySelector('.choice-popup'), null); } finally { view.unmount(); }
});
