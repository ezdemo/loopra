import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = {
  window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: callback => { callback(); return 0; },
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

const reactUrl = import.meta.resolve('react');
const { act, createElement, useRef, useState } = await import(reactUrl);
const { createRoot } = await import('react-dom/client');
const { Simulate } = await import('react-dom/test-utils');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
async function sourceUrl(name, dependencies = {}) {
  const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX,
  } });
  for (const [specifier, url] of Object.entries({ react: reactUrl, 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), ...dependencies })) {
    outputText = outputText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
  }
  return dataUrl(outputText);
}
const composerSource = await readFile(new URL('../src/components/Composer.tsx', import.meta.url), 'utf8');
const iconNames = composerSource.match(/import \{ ([^}]+) \} from 'lucide-react'/)[1].split(',').map(name => name.trim());
const icons = dataUrl(iconNames.map(name => `export const ${name}=()=>null;`).join('\n'));
const nextui = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const Button = ({children, onPress, isDisabled, isIconOnly, variant, color, size, className, ...props}) =>
  createElement('button', {type:'button', className, disabled:isDisabled, onClick:onPress, 'aria-label':props['aria-label']}, children);
export const Chip = ({children}) => createElement('span', null, children);
export const Tooltip = ({children}) => children;
export const Input = () => null, Textarea = () => null, Spinner = () => null, Switch = () => null;
`);
const lib = dataUrl(`
const React = await import(${JSON.stringify(reactUrl)});
export const useLocalState = (_key, initial) => React.useState(initial);
`);
const motion = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const Popup = ({open, children, className}) => open ? createElement('div', {className}, children) : null;
export const Collapse = ({open, children}) => open ? children : null;
`);
const placeholder = dataUrl('export default () => null;');
const Composer = (await import(await sourceUrl('components/Composer.tsx', {
  '@nextui-org/react': nextui, 'lucide-react': icons, '../lib': lib, './Motion': motion,
  '../composer': await sourceUrl('composer.ts'), '../usage': await sourceUrl('usage.ts'),
  '../agent-config': await sourceUrl('agent-config.ts'),
  '../documents': dataUrl(`
    export const LARGE_PASTE_THRESHOLD_CHARS=10000, MAX_DOC_FILE_SIZE=1000000, MAX_IMAGE_COUNT=10, MAX_TEXT_FILE_SIZE=1000000, MAX_UPLOAD_FILES=10;
    export const attachmentLimitReached=()=>false, fileKind=()=>null, extractDocumentText=()=>'', formatFileSize=()=>'';
  `),
  './PetCompanion': placeholder, './ReasoningControl': placeholder, './AgentConfigControls': placeholder,
  '../pets': dataUrl('export const petScale=()=>1;'),
  '../layout/menu-placement': await sourceUrl('layout/menu-placement.ts'),
}))).default;

const advertised = [
  { name: 'clear', description: 'Clear Agent context' },
  { name: 'review', description: 'Review changes', inputHint: 'branch' },
];
const idle = () => {};
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
async function mount(overrides = {}, requestCommands = () => Promise.resolve(advertised)) {
  const calls = [], sends = [], localActions = [];
  const api = { request(path, method, body, signal) {
    calls.push({ path, signal });
    if (path.startsWith('/agent/acp-state?')) return requestCommands(path).then(commands => ({ plan: [], commands }));
    if (path === '/agent/commands') return Promise.resolve([{ cmd: '/compact', desc: 'Compact Native history' }]);
    return Promise.resolve([]);
  } };
  let props = {
    agentId: 'codex', home: false, language: '中文', draft: '/', api, workspaceHash: 'workspace',
    sessionName: 'first', engines: [{ id: 'codex', name: 'Codex' }, { id: 'claude', name: 'Claude Code' }],
    options: { modelId: '', mode: '完全自动', effort: 'high', plan: false, fast: false },
    context: { projects: [], skills: [], files: [] }, providers: [], workspaces: [], history: [],
    onOptions: idle, onContext: idle, notify: idle, pets: {}, petEnabled: false, skillOptions: [],
    systemPrompt: '', defaultModel: '', onDefaultModel: idle, queue: [], onOpen: idle,
    onClear: () => localActions.push('clear'), onNew: () => localActions.push('new'),
    ...overrides,
  };
  function Harness() {
    const inputRef = useRef(null);
    const [draft, setDraft] = useState(props.draft);
    return createElement(Composer, { ...props, inputRef, draft, onDraft: setDraft, onSend: () => sends.push(draft) });
  }
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
  return {
    host, calls, sends, localActions,
    rows: () => [...host.querySelectorAll('.suggestions-list > button')].map(button => button.querySelector('strong').firstChild.textContent),
    async update(next) { props = { ...props, ...next }; await act(async () => root.render(createElement(Harness))); },
    async type(value) {
      const input = host.querySelector('textarea');
      await act(async () => Simulate.change(input, { target: { value } }));
    },
    async key(key) { await act(async () => Simulate.keyDown(host.querySelector('textarea'), { key })); },
    async close() { await act(async () => root.unmount()); host.remove(); },
  };
}

test('ACP slash suggestions use advertised commands and insert without executing local namesakes', async () => {
  const view = await mount();
  try {
    assert.deepEqual(view.rows(), ['/clear', '/review']);
    assert.match(view.host.querySelector('.composer-suggestions').textContent, /Review changes · branch/);
    assert.equal(view.calls.some(call => call.path === '/agent/commands' || call.path === '/agent/skills'), false);
    await act(async () => view.host.querySelector('.suggestions-list > button').click());
    assert.equal(view.host.querySelector('textarea').value, '/clear ');
    assert.deepEqual(view.localActions, []);
    assert.deepEqual(view.sends, []);
    await view.type('/rev');
    assert.deepEqual(view.rows(), ['/review']);
    await view.key('Tab');
    assert.equal(view.host.querySelector('textarea').value, '/review ');
    await view.type('/review main');
    await view.key('Enter');
    assert.deepEqual(view.sends, ['/review main']);
  } finally { await view.close(); }
});

test('ACP suggestions support arrow selection and Escape dismissal', async () => {
  const view = await mount();
  try {
    await view.key('ArrowDown');
    assert.match(view.host.querySelector('.suggestions-list .is-selected').textContent, /review/);
    await view.key('Enter');
    assert.equal(view.host.querySelector('textarea').value, '/review ');
    await view.type('/');
    await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.equal(view.host.querySelector('.composer-suggestions'), null);
    await view.type('/rev');
    assert.deepEqual(view.rows(), ['/review']);
  } finally { await view.close(); }
});

test('live ACP updates replace the command list, including an explicit empty list', async () => {
  const view = await mount({ generating: true, acpCommands: [{ name: 'plan' }] });
  try {
    assert.deepEqual(view.rows(), ['/plan']);
    await view.update({ acpCommands: [{ name: 'review' }] });
    assert.deepEqual(view.rows(), ['/review']);
    await view.update({ acpCommands: [] });
    assert.deepEqual(view.rows(), []);
    assert.match(view.host.querySelector('[role="status"]').textContent, /尚未提供可用指令/);
  } finally { await view.close(); }
});

test('switching Agent or session hides old commands and ignores a late discovery response', async () => {
  const old = deferred(), current = deferred();
  const view = await mount({}, path => path.includes('sessionName=first') ? old.promise : current.promise);
  try {
    assert.match(view.host.querySelector('[role="status"]').textContent, /正在读取/);
    await view.update({ agentId: 'claude', sessionName: 'second' });
    await act(async () => old.resolve([{ name: 'old-codex' }]));
    assert.deepEqual(view.rows(), []);
    await act(async () => current.resolve([{ name: 'claude-command' }]));
    assert.deepEqual(view.rows(), ['/claude-command']);
    assert.match(view.host.querySelector('.suggestions-heading').textContent, /Claude Code/);
  } finally { await view.close(); }
});

test('empty and failed discovery show a status and can retry without sending a message', async () => {
  let attempt = 0;
  const view = await mount({}, async () => {
    attempt++;
    if (attempt === 1) throw new Error('offline');
    return attempt === 2 ? [] : advertised;
  });
  try {
    assert.match(view.host.querySelector('[role="status"]').textContent, /读取 Agent 指令失败/);
    await act(async () => view.host.querySelector('.suggestions-status button').click());
    assert.match(view.host.querySelector('[role="status"]').textContent, /尚未提供可用指令/);
    await act(async () => view.host.querySelector('.suggestions-status button').click());
    assert.deepEqual(view.rows(), ['/clear', '/review']);
    assert.deepEqual(view.sends, []);
  } finally { await view.close(); }
});

test('opening slash suggestions re-reads delayed command announcements', async () => {
  let available = [];
  const view = await mount({ draft: '' }, () => Promise.resolve(available));
  try {
    available = advertised;
    await view.type('/');
    assert.deepEqual(view.rows(), ['/clear', '/review']);
    assert.equal(view.calls.filter(call => call.path.startsWith('/agent/acp-state?')).length, 2);
    await view.type('/missing');
    assert.match(view.host.querySelector('[role="status"]').textContent, /没有匹配/);
  } finally { await view.close(); }
});

test('Native retains local actions and its own server-provided slash commands', async () => {
  const view = await mount({ agentId: 'native' });
  try {
    assert.ok(view.rows().includes('/new'));
    assert.ok(view.rows().includes('/compact'));
    assert.equal(view.calls.some(call => call.path.startsWith('/agent/acp-state?')), false);
    await view.type('/clear');
    await view.key('Enter');
    assert.deepEqual(view.localActions, ['clear']);
    assert.deepEqual(view.sends, []);
  } finally { await view.close(); }
});
