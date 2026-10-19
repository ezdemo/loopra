import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
const { act, createElement, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const ui = dataUrl(`
import { createElement } from ${JSON.stringify(import.meta.resolve('react'))};
export const Spinner = props => createElement('span', { 'data-loading': true, 'aria-label': props['aria-label'] }, 'loading');
export const Button = ({ children, onPress, isDisabled, isLoading, isIconOnly, size, variant, color, ...props }) => createElement('button', { ...props, type: 'button', disabled: !!isDisabled || !!isLoading, onClick: onPress }, isLoading ? createElement(Spinner, {}) : null, children);
export const Modal = ({ children }) => createElement('section', { role: 'dialog' }, children);
export const ModalBody = Modal, ModalContent = Modal, ModalFooter = Modal, ModalHeader = Modal;
`);
const shared = { react: import.meta.resolve('react'), 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), '@nextui-org/react': ui, 'lucide-react': import.meta.resolve('lucide-react') };
async function compile(path, aliases = {}) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
  for (const [specifier, url] of Object.entries({ ...shared, ...aliases })) outputText = outputText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
  return dataUrl(outputText);
}
const model = await compile('../src/git-models.ts'), tree = await compile('../src/git-tree.ts');
const treeView = await compile('../src/components/GitChangeTree.tsx', { '../git-tree': tree });
const remote = await compile('../src/components/RemoteControls.tsx');
const { default: GitTools } = await import(await compile('../src/components/GitTools.tsx', { './GitChangeTree': treeView, './RemoteControls': remote, '../git-models': model }));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const button = label => document.querySelector(`button[aria-label="${label}"]`);
const click = async element => act(async () => element.click());

async function mount({ holdRefresh = false, failStage = false } = {}) {
  const gates = new Map([['a.md', deferred()], ['b.md', deferred()]]), generate = deferred(), pendingReads = [], calls = [], notices = [];
  let refreshHeld = false, active = 0, maxActive = 0;
  const status = { gitAvailable: true, initialized: true, branch: 'main', changed: [{ path: 'a.md', index: ' ', workTree: 'M', status: 'M' }], untracked: [{ path: 'b.md', index: '?', workTree: '?', status: 'U' }] };
  const api = { async request(path, method = 'GET', body) {
    calls.push({ path, method, body });
    if (path.startsWith('/git/toggle')) {
      active++; maxActive = Math.max(maxActive, active);
      await gates.get(body.path).promise; active--;
      if (failStage) throw new Error('Git 操作失败');
      if (holdRefresh) refreshHeld = true;
      return {};
    }
    if (path.startsWith('/git/generate-commit-message')) { await generate.promise; return { message: 'generated message' }; }
    const value = path.startsWith('/git/status') ? status : path.startsWith('/git/log') ? { commits: [{ hash: '1', shortHash: 'abc123', message: 'Existing commit', author: 'Test', date: '2026-10-14' }] } : path === '/models' ? { models: [] } : { authorName: 'Test', authorEmail: 'test@example.com' };
    if (refreshHeld) { const gate = deferred(); pendingReads.push({ gate, value }); return gate.promise; }
    return value;
  } };
  function Wrapper() {
    const [revision, setRevision] = useState(0);
    return createElement(GitTools, { api, workspaceHash: 'project', revision, onRefresh: () => setRevision(value => value + 1), onFile() {}, notify: message => notices.push(message) });
  }
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  await act(async () => root.render(createElement(Wrapper)));
  return {
    gates, generate, calls, notices, pendingReads, maxActive: () => maxActive,
    async finishRefresh() { refreshHeld = false; await act(async () => { for (const { gate, value } of pendingReads.splice(0)) gate.resolve(value); }); },
    async close() { refreshHeld = false; await act(async () => { for (const gate of gates.values()) gate.resolve(); generate.resolve(); for (const { gate, value } of pendingReads.splice(0)) gate.resolve(value); root.unmount(); }); container.remove(); },
  };
}

test('staging and background refresh keep the tree, history and editor without loading indicators', async () => {
  const view = await mount({ holdRefresh: true });
  try {
    const treeElement = document.querySelector('.git-change-tree'), editor = document.querySelector('textarea'), ai = document.querySelector('.git-ai-button');
    await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(editor, 'Keep my draft'); editor.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    await click(button('暂存 a.md'));
    assert.equal(view.notices.at(-1), '正在操作，请稍后…');
    assert.equal(button('暂存 a.md').disabled, true);
    assert.equal(button('暂存 b.md').disabled, false);
    assert.equal(editor.disabled, false);
    assert.equal(ai.disabled, false); assert.match(ai.textContent, /AI 生成说明/);
    assert.equal(document.querySelectorAll('[data-loading]').length, 0);
    await act(async () => view.gates.get('a.md').resolve());
    assert.equal(view.notices.at(-1), '已暂存');
    assert.ok(view.pendingReads.length >= 2);
    assert.equal(document.querySelector('.git-change-tree'), treeElement);
    assert.match(document.querySelector('.git-commit-list').textContent, /Existing commit/);
    assert.equal(editor.value, 'Keep my draft');
    assert.equal(document.querySelectorAll('[data-loading]').length, 0);
    await view.finishRefresh();
    assert.equal(document.querySelector('.git-change-tree'), treeElement);
  } finally { await view.close(); }
});

test('different stage buttons queue their requests without globally disabling the tree', async () => {
  const view = await mount();
  try {
    await click(button('暂存 a.md')); await click(button('暂存 b.md'));
    assert.equal(view.calls.filter(call => call.method === 'POST').length, 1);
    assert.equal(document.querySelector('input[type="checkbox"]').disabled, false);
    await act(async () => view.gates.get('a.md').resolve());
    assert.equal(view.notices.at(-1), '正在操作，请稍后…');
    assert.deepEqual(view.calls.filter(call => call.method === 'POST').map(call => call.body.path), ['a.md', 'b.md']);
    assert.equal(view.maxActive(), 1);
    await act(async () => view.gates.get('b.md').resolve());
    assert.equal(view.notices.at(-1), '已暂存');
    assert.equal(document.querySelectorAll('[data-loading]').length, 0);
  } finally { await view.close(); }
});

test('a failed stage reports the error through the shared notification and keeps the tree visible', async () => {
  const view = await mount({ failStage: true });
  try {
    await click(button('暂存 a.md'));
    await act(async () => view.gates.get('a.md').resolve());
    assert.match(view.notices.at(-1), /操作失败：Git 操作失败/);
    assert.ok(document.querySelector('.git-change-tree'));
    assert.equal(button('暂存 a.md').disabled, false);
    assert.equal(document.querySelectorAll('[data-loading]').length, 0);
  } finally { await view.close(); }
});

test('AI generation uses its own fixed button content without a spinner', async () => {
  const view = await mount();
  try {
    await click(document.querySelector('.git-ai-button'));
    assert.match(document.querySelector('.git-ai-button').textContent, /生成中/);
    assert.equal(document.querySelector('.git-ai-button').getAttribute('aria-busy'), 'true');
    assert.equal(document.querySelectorAll('[data-loading]').length, 0);
    await act(async () => view.generate.resolve());
    assert.equal(document.querySelector('textarea').value, 'generated message');
    assert.match(document.querySelector('.git-ai-button').textContent, /AI 生成说明/);
  } finally { await view.close(); }
});
