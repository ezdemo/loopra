import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
const { act, createElement, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
async function compile(path, aliases = {}) {
  let { outputText } = ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
  for (const [specifier, url] of Object.entries({ react: import.meta.resolve('react'), 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), 'lucide-react': import.meta.resolve('lucide-react'), ...aliases })) outputText = outputText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
  return dataUrl(outputText);
}
const modelUrl = await compile('../src/workspace-tabs.ts');
const model = await import(modelUrl);
const { emptyWorkspaceTabs, openWorkspaceFile, closeWorkspaceFile, updateWorkspaceFilePath, ensureSubAgentTab, openSubAgentTab, closeSubAgentTab, subAgentTabKey } = model;
const { highlightStub, codeViewerStub } = await import('./helpers/highlight.mjs');
const diff = await compile('../src/diff.ts');
const unifiedDiff = await compile('../src/components/UnifiedDiff.tsx', { '../diff': diff, '../highlight': highlightStub });
const events = await compile('../src/workspace-events.ts');
const controls = dataUrl(`export const errorText = cause => cause.message; export const query = values => new URLSearchParams(values).toString();`);
const subAgentView = dataUrl(`
const { createElement } = await import(${JSON.stringify(import.meta.resolve('react'))});
export default ({ subSessionId, label }) => createElement('div', { className: 'subagent-view-stub' }, label + ':' + subSessionId);
`);
const { default: WorkspaceTabs } = await import(await compile('../src/components/WorkspaceTabs.tsx', { './RemoteControls': controls, './UnifiedDiff': unifiedDiff, './CodeViewer': codeViewerStub, './SubAgentView': subAgentView, '../workspace-tabs': modelUrl, '../highlight': highlightStub, '../workspace-events': events }));
const click = async element => act(async () => element.click());
const tab = name => [...document.querySelectorAll('.workspace-tabs [role="tab"]')].find(element => element.textContent === name);

async function mount({ failRead = false } = {}) {
  const calls = [], references = [];
  let update;
  const api = { async request(path) {
    calls.push(path);
    if (failRead) { failRead = false; throw new Error('读取失败'); }
    return path.startsWith('/git/diff-content') ? { diff: '@@ -1 +1 @@\n-old live\n+new live' } : { exists: true, content: `content ${new URLSearchParams(path.split('?')[1]).get('path')}\nsecond line` };
  } };
  function Wrapper() {
    const [state, setState] = useState(emptyWorkspaceTabs); update = setState;
    return createElement(WorkspaceTabs, { api, workspaceHash: 'project', state, notify: () => {},
      onSelect: active => setState(current => ({ ...current, active })),
      onClose: path => setState(current => closeWorkspaceFile(current, path)),
      onCloseSubAgent: id => setState(current => closeSubAgentTab(current, id)),
      onOpen: file => setState(current => openWorkspaceFile(current, file)),
      onAdd: (path, text) => { references.push({ path, text }); setState(current => ({ ...current, active: null })); },
    }, createElement('textarea', { 'aria-label': '消息草稿', defaultValue: 'draft' }));
  }
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  await act(async () => root.render(createElement(Wrapper)));
  return { calls, references,
    async open(file) { await act(async () => update(current => openWorkspaceFile(current, file))); },
    async openAgent(tab, select = false) { await act(async () => update(current => select ? openSubAgentTab(current, tab) : ensureSubAgentTab(current, tab))); },
    async close() { await act(async () => root.unmount()); container.remove(); } };
}

test('only the conversation has no tab bar; opening and closing the last file restores that layout', async () => {
  const view = await mount();
  try {
    assert.equal(document.querySelector('.workspace-tabs'), null);
    const draft = document.querySelector('textarea'); draft.value = 'unsent draft';
    await view.open({ path: 'README.md', mode: 'content' });
    assert.equal(tab('会话').getAttribute('aria-selected'), 'false');
    assert.equal(document.querySelector('.workspace-chat-view').hidden, true);
    assert.match(document.querySelector('.workspace-code-editor').textContent, /content README.md/);
    await click(document.querySelector('[aria-label="关闭 README.md"]'));
    assert.equal(document.querySelector('.workspace-tabs'), null);
    assert.equal(document.querySelector('.workspace-chat-view').hidden, false);
    assert.equal(document.querySelector('textarea'), draft);
    assert.equal(draft.value, 'unsent draft');
  } finally { await view.close(); }
});

test('reopening a file selects its existing tab and preserves mounted file and conversation views', async () => {
  const view = await mount();
  try {
    await view.open({ path: 'src/a.ts', mode: 'content' });
    const firstView = document.querySelector('.workspace-file-view'), body = firstView.querySelector('.workspace-file-body'); body.scrollTop = 75;
    await view.open({ path: 'src/b.ts', mode: 'content' });
    await view.open({ path: 'src\\a.ts', mode: 'content' });
    assert.equal(document.querySelectorAll('.workspace-file-tab').length, 2);
    assert.equal(document.querySelector('.workspace-file-view'), firstView);
    assert.equal(body.scrollTop, 75);
    await click(tab('会话'));
    assert.equal(document.querySelector('.workspace-chat-view').hidden, false);
    assert.equal(document.querySelectorAll('.workspace-file-tab').length, 2);
  } finally { await view.close(); }
});

test('historical diffs keep the saved content while opening the live Git entry replaces it', async () => {
  const view = await mount();
  try {
    await view.open({ path: 'a.md', mode: 'diff', diff: '@@ -1 +1 @@\n-old saved\n+new saved' });
    assert.equal(view.calls.length, 0);
    assert.match(document.querySelector('.unified-diff').textContent, /new saved/);
    await click([...document.querySelectorAll('.workspace-view-modes button')].find(button => button.textContent === '原文件'));
    assert.match(document.querySelector('.workspace-code-editor').textContent, /content a.md/);
    await click([...document.querySelectorAll('.workspace-view-modes button')].find(button => button.textContent === '本次改动'));
    assert.match(document.querySelector('.unified-diff').textContent, /new saved/);
    assert.equal(view.calls.filter(path => path.startsWith('/git/diff-content')).length, 0);
    await view.open({ path: 'a.md', mode: 'diff' });
    assert.match(document.querySelector('.unified-diff').textContent, /new live/);
    assert.equal(document.querySelectorAll('.workspace-file-tab').length, 1);
  } finally { await view.close(); }
});

test('file read failures can retry and a reference returns to the existing conversation', async () => {
  const view = await mount({ failRead: true });
  try {
    await view.open({ path: 'a.md', mode: 'content' });
    assert.match(document.querySelector('[role="alert"]').textContent, /读取失败/);
    await click(document.querySelector('[role="alert"] button'));
    assert.match(document.querySelector('.workspace-code-editor').textContent, /content a.md/);
    await click([...document.querySelectorAll('.workspace-file-actions button')].find(button => button.textContent === '引用文件'));
    assert.deepEqual(view.references, [{ path: 'a.md', text: undefined }]);
    assert.equal(document.querySelector('.workspace-chat-view').hidden, false);
  } finally { await view.close(); }
});

test('sub-agent runs open in the tab bar next to the conversation without stealing focus', async () => {
  const view = await mount();
  try {
    await view.openAgent({ subSessionId: 'run-1', sessionName: 'chat-1', label: '小瓜：修复登录' });
    const label = tab('小瓜：修复登录');
    assert.ok(label, 'a live sub-agent run gets its own tab');
    assert.equal(document.querySelector('.workspace-subagent-tab').getAttribute('data-active'), 'false');
    assert.equal(document.querySelector('.workspace-chat-view').hidden, false);
    await click(label);
    assert.equal(document.querySelector('.workspace-subagent-tab').getAttribute('data-active'), 'true');
    assert.equal(document.querySelector('.workspace-chat-view').hidden, true);
    assert.match(document.querySelector('.subagent-view-stub').textContent, /小瓜：修复登录:run-1/);
    await click(document.querySelector('[aria-label="关闭 小瓜：修复登录"]'));
    assert.equal(document.querySelector('.workspace-tabs'), null);
    assert.equal(document.querySelector('.workspace-chat-view').hidden, false);
  } finally { await view.close(); }
});

test('sub-agent tabs coexist with file tabs', async () => {
  const view = await mount();
  try {
    await view.open({ path: 'src/a.ts', mode: 'content' });
    await view.openAgent({ subSessionId: 'run-1', sessionName: 'chat-1', label: '测试代理' }, true);
    assert.equal(document.querySelectorAll('.workspace-file-tab').length, 2);
    assert.equal(document.querySelector('.workspace-subagent-tab').getAttribute('data-active'), 'true');
    await view.open({ path: 'src/b.ts', mode: 'content' });
    assert.equal(document.querySelectorAll('.workspace-subagent-tab').length, 1);
  } finally { await view.close(); }
});

test('sub-agent tab helpers refresh, focus and pick a neighbour on close', () => {
  let state = emptyWorkspaceTabs;
  state = ensureSubAgentTab(state, { subSessionId: 'a', sessionName: 's', label: 'A' });
  state = ensureSubAgentTab(state, { subSessionId: 'b', sessionName: 's', label: 'B' });
  assert.equal(state.active, null, 'background runs must not steal the active view');
  assert.deepEqual(state.agents.map(agent => agent.label), ['A', 'B']);
  state = openSubAgentTab(state, { subSessionId: 'a', sessionName: 's', label: 'A2' });
  assert.equal(state.active, subAgentTabKey('a'));
  assert.equal(state.agents[0].label, 'A2');
  assert.equal(state.agents.length, 2);
  state = closeSubAgentTab(state, 'a');
  assert.equal(state.active, subAgentTabKey('b'), 'closing the active tab selects its neighbour');
  state = closeSubAgentTab(state, 'b');
  assert.deepEqual(state, emptyWorkspaceTabs);
});

test('closing tabs selects a neighbor and renaming or deleting a directory updates descendant tabs', () => {
  let state = openWorkspaceFile(emptyWorkspaceTabs, { path: 'src/a.ts', mode: 'content' });
  state = openWorkspaceFile(state, { path: 'src/b.ts', mode: 'content' });
  state = openWorkspaceFile(state, { path: 'other.ts', mode: 'content' });
  state = closeWorkspaceFile(state, 'other.ts');
  assert.equal(state.active, 'src/b.ts');
  state = updateWorkspaceFilePath(state, 'src', 'app');
  assert.deepEqual(state.files.map(file => file.path), ['app/a.ts', 'app/b.ts']);
  assert.equal(state.active, 'app/b.ts');
  state = updateWorkspaceFilePath(state, 'app');
  assert.deepEqual(state, emptyWorkspaceTabs);
});
