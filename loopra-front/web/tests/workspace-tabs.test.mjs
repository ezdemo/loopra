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
const { codeViewerStub } = await import('./helpers/highlight.mjs');
const events = await compile('../src/workspace-events.ts');
const controls = dataUrl(`export const errorText = cause => cause.message; export const query = values => new URLSearchParams(values).toString();`);
const subAgentView = dataUrl(`
const { createElement } = await import(${JSON.stringify(import.meta.resolve('react'))});
export default ({ subSessionId, label }) => createElement('div', { className: 'subagent-view-stub' }, label + ':' + subSessionId);
`);
const { default: WorkspaceTabs } = await import(await compile('../src/components/WorkspaceTabs.tsx', { './RemoteControls': controls, './CodeViewer': codeViewerStub, './SubAgentView': subAgentView, '../workspace-tabs': modelUrl, '../workspace-events': events }));
const click = async element => act(async () => element.click());
const tab = name => [...document.querySelectorAll('.workspace-tabs [role="tab"]')].find(element => element.textContent === name);

async function mount({ failRead = false, gitRead, fileRead } = {}) {
  const calls = [];
  let update;
  const api = { async request(path) {
    calls.push(path);
    if (failRead) { failRead = false; throw new Error('读取失败'); }
    if (path.includes('/diff-content')) return gitRead ? gitRead(path) : { diff: '@@ -1 +1 @@\n-old live\n+new live' };
    if (fileRead) return fileRead(path);
    return { exists: true, content: `content ${new URLSearchParams(path.split('?')[1]).get('path')}\nsecond line` };
  } };
  function Wrapper() {
    const [state, setState] = useState(emptyWorkspaceTabs); update = setState;
    return createElement(WorkspaceTabs, { api, workspaceHash: 'project', state, notify: () => {},
      onSelect: active => setState(current => ({ ...current, active })),
      onClose: path => setState(current => closeWorkspaceFile(current, path)),
      onCloseSubAgent: id => setState(current => closeSubAgentTab(current, id)),
      onOpen: file => setState(current => openWorkspaceFile(current, file)),
    }, createElement('textarea', { 'aria-label': '消息草稿', defaultValue: 'draft' }));
  }
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  await act(async () => root.render(createElement(Wrapper)));
  return { calls,
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

test('file, Git and historical change links share the original file with inline Git changes', async () => {
  const view = await mount();
  try {
    await view.open({ path: 'a.md', mode: 'diff', diff: '@@ -1 +1 @@\n-old saved\n+new saved' });
    const editor = document.querySelector('.workspace-code-editor');
    assert.match(editor.textContent, /content a.md/);
    assert.match(editor.getAttribute('data-git-diff'), /old live/);
    assert.equal(document.querySelector('.unified-diff'), null);
    assert.equal(document.querySelector('.workspace-view-modes'), null);
    assert.equal(document.querySelectorAll('.workspace-file-toolbar button').length, 0);
    assert.equal(document.querySelector('.workspace-file-tab small'), null);
    await view.open({ path: 'a.md', mode: 'content' });
    await view.open({ path: 'a.md', mode: 'diff' });
    assert.equal(document.querySelector('.workspace-code-editor'), editor);
    assert.match(editor.getAttribute('data-git-diff'), /old live/);
    assert.equal(document.querySelectorAll('.workspace-file-tab').length, 1);
  } finally { await view.close(); }
});

const mouse = async (element, type, button) => {
  let event;
  await act(async () => {
    event = new window.MouseEvent(type, { bubbles: true, cancelable: true, button });
    element.dispatchEvent(event);
  });
  return event;
};

test('middle click closes inactive and active file tabs without selecting the inactive file', async () => {
  const view = await mount();
  try {
    await view.open({ path: 'first.ts', mode: 'content' });
    await view.open({ path: 'second.ts', mode: 'content' });
    const first = tab('first.ts');
    assert.equal((await mouse(first, 'mousedown', 1)).defaultPrevented, true);
    assert.equal(document.querySelectorAll('.workspace-file-tab').length, 2);
    assert.equal((await mouse(first.querySelector('svg'), 'auxclick', 1)).defaultPrevented, true);
    assert.equal(tab('first.ts'), undefined);
    assert.equal(tab('second.ts').getAttribute('aria-selected'), 'true');
    await mouse(tab('second.ts'), 'auxclick', 2);
    assert.ok(tab('second.ts'), 'right click does not close the tab');
    await mouse(tab('会话'), 'auxclick', 1);
    assert.equal(tab('会话').getAttribute('aria-selected'), 'false');
    await mouse(document.querySelector('.workspace-tab-close'), 'auxclick', 1);
    assert.equal(document.querySelector('.workspace-tabs'), null);
    assert.equal(document.querySelector('.workspace-chat-view').hidden, false);
  } finally { await view.close(); }
});

test('middle click closes a sub-agent tab and leaves the selected file open', async () => {
  const view = await mount();
  try {
    await view.open({ path: 'first.ts', mode: 'content' });
    await view.openAgent({ subSessionId: 'run-1', sessionName: 'chat-1', label: '测试代理' });
    await mouse(tab('测试代理'), 'auxclick', 1);
    assert.equal(document.querySelector('.workspace-subagent-tab'), null);
    assert.equal(tab('first.ts').getAttribute('aria-selected'), 'true');
  } finally { await view.close(); }
});

test('original preview receives live Git changes from the matching environment', async () => {
  const view = await mount();
  try {
    await view.open({ path: 'src/demo.java', mode: 'content', environment: 'isolated-session' });
    const request = view.calls.find(path => path.startsWith('/git/environment/diff-content?'));
    assert.ok(request);
    const params = new URLSearchParams(request.split('?')[1]);
    assert.equal(params.get('sessionName'), 'isolated-session');
    assert.equal(params.get('path'), 'src/demo.java');
    assert.match(document.querySelector('.workspace-code-editor').getAttribute('data-git-diff'), /old live/);
    assert.equal(view.calls.some(path => path.startsWith('/git/diff-content?')), false);
  } finally { await view.close(); }
});

test('a pending Git read does not delay the file and a late result cannot update another environment', async () => {
  const pending = [];
  const view = await mount({ gitRead: () => new Promise(resolve => pending.push(resolve)) });
  try {
    await view.open({ path: 'first.ts', mode: 'content' });
    assert.match(document.querySelector('.workspace-code-editor').textContent, /content first.ts/);
    await view.open({ path: 'first.ts', mode: 'diff', environment: 'other-session' });
    await act(async () => pending[1]({ diff: 'new environment diff' }));
    await act(async () => pending[0]({ diff: 'stale environment diff' }));
    assert.equal(document.querySelector('.workspace-code-editor').getAttribute('data-git-diff'), 'new environment diff');
  } finally { await view.close(); }
});

test('files remain readable when Git is unavailable', async () => {
  const view = await mount({ gitRead: async () => { throw new Error('not a git repository'); } });
  try {
    await view.open({ path: 'first.ts', mode: 'content' });
    assert.match(document.querySelector('.workspace-code-editor').textContent, /content first.ts/);
    assert.equal(document.querySelector('[role="alert"]'), null);
  } finally { await view.close(); }
});

test('file read failures can retry and the conversation draft stays mounted', async () => {
  const view = await mount({ failRead: true });
  try {
    await view.open({ path: 'a.md', mode: 'content' });
    assert.match(document.querySelector('[role="alert"]').textContent, /读取失败/);
    await click(document.querySelector('[role="alert"] button'));
    assert.match(document.querySelector('.workspace-code-editor').textContent, /content a.md/);
    await click(tab('会话'));
    assert.equal(document.querySelector('.workspace-chat-view').hidden, false);
    assert.equal(document.querySelector('textarea').value, 'draft');
  } finally { await view.close(); }
});

test('workspace notifications refresh the original content and inline Git changes automatically', async () => {
  let content = 'before refresh', diff = 'first diff';
  const view = await mount({ fileRead: () => ({ exists: true, content }), gitRead: () => ({ diff }) });
  try {
    await view.open({ path: 'first.ts', mode: 'content' });
    const editor = document.querySelector('.workspace-code-editor');
    content = 'after refresh'; diff = 'updated diff';
    await act(async () => window.dispatchEvent(new window.CustomEvent('loopra:workspace-changed', { detail: { workspaceHash: 'project' } })));
    assert.equal(document.querySelector('.workspace-code-editor'), editor);
    assert.equal(editor.textContent, 'after refresh');
    assert.equal(editor.getAttribute('data-git-diff'), 'updated diff');
  } finally { await view.close(); }
});

test('the tab refresh button reloads only its file and Git changes without selecting it', async () => {
  let version = 1;
  const view = await mount({
    fileRead: path => ({ exists: true, content: `${new URLSearchParams(path.split('?')[1]).get('path')} version ${version}` }),
    gitRead: () => ({ diff: `diff version ${version}` }),
  });
  try {
    await view.open({ path: 'first.ts', mode: 'content' });
    const editor = document.querySelector('.workspace-code-editor');
    await view.open({ path: 'second.ts', mode: 'content' });
    const before = view.calls.length;
    version = 2;
    await click(document.querySelector('[aria-label="刷新 first.ts"]'));
    assert.equal(tab('second.ts').getAttribute('aria-selected'), 'true');
    assert.equal(document.querySelectorAll('.workspace-file-tab').length, 2);
    assert.equal(document.querySelector('.workspace-code-editor'), editor);
    assert.equal(editor.textContent, 'first.ts version 2');
    assert.equal(editor.getAttribute('data-git-diff'), 'diff version 2');
    const requests = view.calls.slice(before);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(path => new URLSearchParams(path.split('?')[1]).get('path') === 'first.ts'));
  } finally { await view.close(); }
});

test('deleted Git files remain inspectable through the inline preview on an empty original', async () => {
  const diff = '@@ -1,2 +0,0 @@\n-deleted first\n-deleted second';
  const view = await mount({ fileRead: () => ({ exists: false, content: null }), gitRead: () => ({ diff }) });
  try {
    await view.open({ path: 'removed.ts', mode: 'diff' });
    const editor = document.querySelector('.workspace-code-editor');
    assert.ok(editor);
    assert.equal(editor.textContent, '');
    assert.equal(editor.getAttribute('data-git-diff'), diff);
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
