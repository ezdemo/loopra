import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// 「从此回复继续到新会话」的引擎选择对话框：源引擎是默认项，候选只列
// 可用且未隐藏的引擎；提交、忙碌锁定、失败保留选择与取消路径都有约定。
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true };
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
export const Button = ({ children, onPress, isDisabled, isLoading }) =>
  createElement('button', { type: 'button', disabled: !!isDisabled, 'data-loading': isLoading ? 'true' : undefined, onClick: onPress }, children);
export const Modal = ({ isOpen, children, 'aria-label': label }) => isOpen ? createElement('div', { role: 'dialog', 'aria-label': label }, children) : null;
export const ModalBody = ({ children }) => createElement('div', null, children);
export const ModalContent = ({ children }) => createElement('div', null, children);
export const ModalFooter = ({ children }) => createElement('div', null, children);
export const ModalHeader = ({ children }) => createElement('div', null, children);
`);
const controlsStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const SelectField = ({ label, value, onChange, options, disabled }) =>
  createElement('div', { role: 'listbox', 'aria-label': label, 'data-value': value, 'data-disabled': disabled ? 'true' : undefined },
    options.map(option => createElement('button', {
      key: option.value, type: 'button', role: 'option', 'aria-selected': String(option.value === value),
      disabled: !!disabled, onClick: () => onChange(option.value),
    }, option.label)));
`);
const remoteStub = dataUrl(`export const errorText = cause => cause instanceof Error ? cause.message : String(cause);`);
const iconStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const GitBranch = () => null;
`);
const { default: SessionBranchDialog } = await import(await sourceUrl('components/SessionBranchDialog.tsx', {
  '@nextui-org/react': nextuiStub,
  './SettingControls': controlsStub,
  './RemoteControls': remoteStub,
  'lucide-react': iconStub,
}));

const ENGINES = [
  { id: 'native', name: 'Loopra Native', available: true },
  { id: 'codex', name: 'Codex', available: true },
  { id: 'claude-code', name: 'Claude Code', available: false, detail: 'not installed' },
  { id: 'devin', name: 'Devin', available: true, hidden: true },
];

function mount(props) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = patch => act(() => root.render(createElement(SessionBranchDialog, { engines: ENGINES, busy: false, onConfirm: async () => {}, onClose: () => {}, ...props })));
  const select = () => host.querySelector('[role="listbox"]');
  const options = () => [...select().querySelectorAll('[role="option"]')];
  const buttons = () => [...host.querySelectorAll('button')].filter(button => !button.matches('[role="option"]'));
  const confirm = () => buttons().find(button => button.textContent.includes('创建分支') || button.textContent.includes('正在创建'));
  const cancel = () => buttons().find(button => button.textContent === '取消');
  const unmount = () => { act(() => root.unmount()); host.remove(); };
  return { host, render, select, options, confirm, cancel, unmount };
}

test('the source engine is the default and only available visible engines are options', async () => {
  const view = mount({ sourceAgentId: 'codex' });
  try {
    await view.render();
    assert.equal(view.select().dataset.value, 'codex');
    assert.deepEqual(view.options().map(option => option.textContent), ['Codex', 'Loopra Native']);
    assert.equal(view.options()[0].getAttribute('aria-selected'), 'true');
  } finally { view.unmount(); }
});

test('an unavailable or hidden source stays selectable as the default', async () => {
  const view = mount({ sourceAgentId: 'devin' });
  try {
    await view.render();
    assert.equal(view.select().dataset.value, 'devin');
    assert.deepEqual(view.options().map(option => option.textContent), ['Devin', 'Loopra Native', 'Codex']);
  } finally { view.unmount(); }
});

test('confirming submits the selected engine and closes', async () => {
  const calls = [];
  const closed = [];
  const view = mount({ sourceAgentId: 'native', onConfirm: async id => { calls.push(id); }, onClose: () => closed.push(true) });
  try {
    await view.render();
    act(() => { view.options().find(option => option.textContent === 'Codex').click(); });
    assert.equal(view.select().dataset.value, 'codex');
    await act(async () => { view.confirm().click(); });
    assert.deepEqual(calls, ['codex']);
    assert.deepEqual(closed, [true]);
  } finally { view.unmount(); }
});

test('a pending submission cannot be submitted twice', async () => {
  const calls = [];
  let finish;
  const view = mount({ sourceAgentId: 'native', onConfirm: id => { calls.push(id); return new Promise(resolve => { finish = resolve; }); } });
  try {
    await view.render();
    await act(async () => { view.confirm().click(); view.confirm().click(); });
    assert.deepEqual(calls, ['native']);
    await act(async () => { finish(); });
  } finally { view.unmount(); }
});

test('a failed submission keeps the chosen engine and reports the error', async () => {
  const calls = [];
  const view = mount({ sourceAgentId: 'native', onConfirm: async id => { calls.push(id); throw new Error('目标 Agent 不可用'); } });
  try {
    await view.render();
    act(() => { view.options().find(option => option.textContent === 'Codex').click(); });
    await act(async () => { view.confirm().click(); });
    assert.deepEqual(calls, ['codex']);
    assert.equal(view.host.querySelector('[role="alert"]').textContent, '目标 Agent 不可用');
    assert.equal(view.select().dataset.value, 'codex');
    assert.ok(view.host.querySelector('[role="dialog"]'));
  } finally { view.unmount(); }
});

test('cancel closes without submitting', async () => {
  const calls = [];
  const closed = [];
  const view = mount({ sourceAgentId: 'native', onConfirm: async id => { calls.push(id); }, onClose: () => closed.push(true) });
  try {
    await view.render();
    await act(async () => { view.cancel().click(); });
    assert.deepEqual(calls, []);
    assert.deepEqual(closed, [true]);
  } finally { view.unmount(); }
});

test('busy state locks the options and both buttons', async () => {
  const view = mount({ sourceAgentId: 'native', busy: true });
  try {
    await view.render();
    assert.equal(view.select().dataset.disabled, 'true');
    assert.ok([...view.host.querySelectorAll('button')].every(button => button.disabled));
    assert.equal(view.confirm().dataset.loading, 'true');
  } finally { view.unmount(); }
});
