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
const selectorSource = await readFile(new URL('../src/components/ModelReasoningSelector.tsx', import.meta.url), 'utf8');
const iconNames = [...new Set([...[composerSource, selectorSource].join('\n').matchAll(/import \{ ([^}]+) \} from 'lucide-react'/g)].flatMap(match => match[1].split(',').map(name => name.trim())))];
const icons = dataUrl([...iconNames, 'Brain'].map(name => `export const ${name}=()=>null;`).join('\n'));
const nextui = dataUrl(`
const { createElement, forwardRef } = await import(${JSON.stringify(reactUrl)});
export const Button = forwardRef(({children, onPress, isDisabled, isIconOnly, variant, color, size, className, ...props}, ref) =>
  createElement('button', {type:'button', ref, className, disabled:isDisabled, onClick:onPress, ...props}, children));
export const Chip = ({children}) => createElement('span', null, children);
export const Tooltip = ({children}) => children;
export const Input = ({value, onValueChange, 'aria-label':label, autoFocus, isDisabled}) => createElement('input', {value, autoFocus, disabled:isDisabled, 'aria-label':label, onChange:event=>onValueChange(event.target.value)});
export const Slider = ({value, className}) => createElement('div', {className, 'data-value':value});
export const Switch = ({isSelected, isDisabled, onValueChange, 'aria-label':label}) => createElement('input', {type:'checkbox', checked:isSelected, disabled:isDisabled, 'aria-label':label, onChange:event=>onValueChange(event.target.checked)});
export const Textarea = () => null, Spinner = () => null;
export const Modal = () => null, ModalBody = () => null, ModalContent = () => null, ModalFooter = () => null, ModalHeader = () => null;
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
const selectorDependencies = {
  '@nextui-org/react': nextui, 'lucide-react': icons, './Motion': motion,
  '../composer': await sourceUrl('composer.ts'), '../agent-config': await sourceUrl('agent-config.ts'),
  '../layout/menu-placement': await sourceUrl('layout/menu-placement.ts'),
};
const reasoning = await sourceUrl('components/ReasoningControl.tsx', selectorDependencies);
const selector = await sourceUrl('components/ModelReasoningSelector.tsx', { ...selectorDependencies, './ReasoningControl': reasoning, './AgentIcon': await sourceUrl('components/AgentIcon.tsx') });
const mcpControls = await sourceUrl('components/AgentMcpControls.tsx', {
  '@nextui-org/react': nextui, 'lucide-react': icons,
  './RemoteControls': await sourceUrl('components/RemoteControls.tsx', { '@nextui-org/react': nextui }),
  '../capabilities': await sourceUrl('capabilities.ts'),
});
const Composer = (await import(await sourceUrl('components/Composer.tsx', {
  '@nextui-org/react': nextui, 'lucide-react': icons, '../lib': lib, './Motion': motion,
  '../composer': await sourceUrl('composer.ts'), '../usage': await sourceUrl('usage.ts'),
  '../agent-config': await sourceUrl('agent-config.ts'),
  '../documents': dataUrl(`
    export const LARGE_PASTE_THRESHOLD_CHARS=10000, MAX_DOC_FILE_SIZE=1000000, MAX_IMAGE_COUNT=10, MAX_TEXT_FILE_SIZE=1000000, MAX_UPLOAD_FILES=10;
    export const attachmentLimitReached=()=>false, fileKind=()=>null, extractDocumentText=()=>'', formatFileSize=()=>'';
  `),
  './PetCompanion': placeholder, './ModelReasoningSelector': selector, './AgentConfigControls': placeholder, './AgentMcpControls': mcpControls,
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
    if (path === '/agent/commands') return Promise.resolve([
      { cmd: '/compact', desc: 'Compact Native history' },
      { cmd: '/plugin', desc: 'Install plugins' }, { cmd: '/init', desc: 'Initialize project' },
    ]);
    if (path === '/agent/skills') return Promise.resolve([{ name: 'project-skill', description: 'Project skill' }]);
    return Promise.resolve([]);
  } };
  let props = {
    agentId: 'codex', connected: true, home: false, language: '中文', draft: '/', api, workspaceHash: 'workspace',
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

test('initial configuration loading reserves toolbar controls with skeletons and swaps in real options', async () => {
  const agentConfig = { busy: true, options: undefined, onChange: idle, onPrepare: idle };
  const view = await mount({ draft: '', agentConfig });
  try {
    assert.equal(view.host.querySelector('.composer-bottom').getAttribute('aria-busy'), 'true');
    assert.equal(view.host.querySelectorAll('.composer-skeleton').length, 8);
    assert.match(view.host.querySelector('[role="status"]').textContent, /正在加载输入栏配置/);
    assert.equal(view.host.querySelector('.composer-bottom button'), null, 'initial placeholders cannot trigger unready controls');
    const options = [
      { id: 'mode', category: 'mode', type: 'select', currentValue: 'safe', options: [{ value: 'safe', name: '按需审批' }] },
      { id: 'model', category: 'model', type: 'select', currentValue: 'raw/model-id', options: [{ value: 'raw/model-id', name: 'DeepSeek Flash' }] },
    ];
    await view.update({ agentConfig: { ...agentConfig, busy: false, options } });
    assert.equal(view.host.querySelector('.composer-skeleton'), null);
    assert.equal(view.host.querySelector('.composer-bottom').getAttribute('aria-busy'), null);
    assert.equal(view.host.querySelector('.composer-model > span').textContent, 'DeepSeek Flash');
    await view.update({ agentConfig: { ...agentConfig, options } });
    assert.equal(view.host.querySelector('.composer-skeleton'), null, 'reconnecting with cached options preserves the known controls');
    assert.equal(view.host.querySelector('.composer-model').disabled, true);
  } finally { await view.close(); }
});

test('configuration failures and running sessions keep retry and stop controls instead of skeletons', async () => {
  const view = await mount({ draft: '', agentConfig: { busy: true, error: 'offline', onPrepare: idle } });
  try {
    assert.ok(view.host.querySelector('[aria-label="重试加载 Agent 配置"]'));
    assert.equal(view.host.querySelector('.composer-skeleton'), null);
    await view.update({ agentConfig: { busy: true }, generating: true });
    assert.ok(view.host.querySelector('[aria-label="停止生成"]'));
    assert.equal(view.host.querySelector('.composer-skeleton'), null);
  } finally { await view.close(); }
});

test('configured display names render in the composer and choosing them retains the raw model identity', async () => {
  const name = 'remote-magpie/opendesign-plugin/deepseek-v4.1-flash';
  const modelId = `custom:${name}`;
  const changes = [];
  const view = await mount({ agentId: 'native', draft: '', providers: [{ id: 'custom', name: 'Custom', models: [{ name, displayName: 'DeepSeek Flash' }] }], options: { modelId, mode: '完全自动', effort: 'high', plan: false, fast: false }, onOptions: value => changes.push(value.modelId) });
  try {
    assert.equal(view.host.querySelector('.composer-model > span').textContent, 'DeepSeek Flash');
    await act(async () => view.host.querySelector('.composer-model').click());
    await act(async () => view.host.querySelector('.model-reasoning-rows > button').click());
    const choice = view.host.querySelector('[role="radio"][aria-label="Custom / DeepSeek Flash"]');
    assert.ok(choice); assert.equal(choice.title, name);
    assert.equal(choice.querySelector('small').textContent, name);
    await act(async () => choice.click());
    assert.deepEqual(changes, [modelId]);
  } finally { await view.close(); }
});

test('Native ACP display names preserve the raw selection and default-model value', async () => {
  const changes = [], defaults = [];
  const value = 'main:namespace/raw-model';
  const view = await mount({ agentId: 'native', draft: '', defaultModel: value, onDefaultModel: id => defaults.push(id), agentConfig: { busy: false, onPrepare() {}, onChange: (...args) => changes.push(args), options: [{ id: 'model', name: '模型', type: 'select', category: 'model', currentValue: value, options: [{ value, name: 'Main / Flash / 中文名', description: 'namespace/raw-model' }] }] } });
  try {
    assert.equal(view.host.querySelector('.composer-model > span').textContent, 'Flash / 中文名');
    await act(async () => view.host.querySelector('.composer-model').click());
    await act(async () => view.host.querySelector('.model-reasoning-rows > button').click());
    const choice = view.host.querySelector('[role="radio"][aria-label="Main / Flash / 中文名"]');
    assert.equal(choice.querySelector('small').textContent, 'namespace/raw-model');
    await act(async () => view.host.querySelector('.model-star').click());
    assert.deepEqual(defaults, [value]);
    await act(async () => choice.click());
    assert.deepEqual(changes, [['model', value]]);
  } finally { await view.close(); }
});

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

test('Native waits for the service connection before loading commands, skills and presets', async () => {
  const view = await mount({ agentId: 'native', connected: false });
  try {
    assert.deepEqual(view.calls, []);
    await view.update({ connected: true });
    for (const path of ['/agent/commands', '/agent/skills', '/prompt-presets']) {
      assert.ok(view.calls.some(call => call.path === path), `missing ${path}`);
    }
    assert.ok(view.rows().includes('/compact'));
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

test('pure chat filters project commands and skips skills; switching back restores both', async () => {
  const view = await mount({ agentId: 'native', chatMode: true, workspaceHash: '__loopra_chat__' });
  try {
    assert.ok(view.rows().includes('/compact'));
    assert.equal(view.rows().includes('/plugin'), false);
    assert.equal(view.rows().includes('/init'), false);
    assert.equal(view.rows().some(row => row.startsWith('/skill:')), false);
    assert.equal(view.calls.some(call => call.path === '/agent/skills'), false);
    await view.update({ chatMode: false, workspaceHash: 'project' });
    assert.ok(view.rows().includes('/plugin'));
    assert.ok(view.rows().includes('/init'));
    assert.ok(view.rows().includes('/skill:project-skill'));
    assert.equal(view.calls.filter(call => call.path === '/agent/skills').length, 1);
    await view.update({ chatMode: true, workspaceHash: '__loopra_chat__' });
    assert.equal(view.rows().includes('/plugin'), false);
    assert.equal(view.rows().some(row => row.startsWith('/skill:')), false);
  } finally { await view.close(); }
});


test('combined model and reasoning menu supports overview, back, Escape and outside dismissal', async () => {
  const options = { modelId: 'custom:flash', mode: '完全自动', effort: 'max', plan: false, fast: false };
  const view = await mount({ agentId: 'native', draft: '', options, providers: [{ id: 'custom', name: 'Custom', models: [{ name: 'flash', displayName: 'DeepSeek V4.1 Flash' }] }] });
  const click = selector => act(async () => view.host.querySelector(selector).click());
  try {
    assert.equal(view.host.querySelectorAll('.composer-model').length, 1);
    assert.equal(view.host.querySelector('.composer-effort'), null);
    assert.match(view.host.querySelector('.composer-model').textContent, /DeepSeek V4.1 Flash·Max/);
    await click('.composer-model');
    assert.deepEqual([...view.host.querySelectorAll('.model-reasoning-rows > button')].map(button => button.textContent), ['模型DeepSeek V4.1 Flash', '推理Max']);
    await click('.model-reasoning-rows > button');
    assert.ok(view.host.querySelector('[aria-label="搜索模型或供应商"]'));
    await click('[aria-label="收起设置面板"]');
    assert.ok(view.host.querySelector('.model-reasoning-rows'));
    await click('.model-reasoning-rows > button:last-child');
    await act(async () => Simulate.keyDown(view.host.querySelector('[role="dialog"]'), { key: 'Escape' }));
    assert.ok(view.host.querySelector('.model-reasoning-rows'));
    await act(async () => Simulate.keyDown(view.host.querySelector('[role="dialog"]'), { key: 'Escape' }));
    assert.equal(view.host.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, view.host.querySelector('.composer-model'));
    await click('.composer-model');
    await act(async () => view.host.querySelector('textarea').dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true })));
    assert.equal(view.host.querySelector('[role="dialog"]'), null);
  } finally { await view.close(); }
});

test('combined selector saves Native reasoning and fast mode while preserving model options', async () => {
  const changes = [];
  const options = { modelId: 'custom:flash', mode: '完全自动', effort: 'max', plan: true, fast: false };
  const view = await mount({ agentId: 'native', draft: '', options, onOptions: value => changes.push(value) });
  try {
    await act(async () => view.host.querySelector('.composer-model').click());
    await act(async () => view.host.querySelector('.model-reasoning-rows > button:last-child').click());
    await act(async () => view.host.querySelector('[aria-label="推理强度：低"]').click());
    assert.deepEqual(changes[0], { ...options, effort: 'low' });
    await view.update({ options: changes[0] });
    await act(async () => Simulate.change(view.host.querySelector('[aria-label="快速模式"]'), { target: { checked: true } }));
    assert.deepEqual(changes[1], { ...options, effort: 'low', fast: true });
    await view.update({ options: changes[1] });
    assert.equal(view.host.querySelector('.model-reasoning-effort').textContent, 'Low');
    assert.ok(view.host.querySelector('.effort-body'), 'saving keeps the reasoning panel mounted');
  } finally { await view.close(); }
});

test('external Agents expose only advertised reasoning choices and preserve custom option IDs', async () => {
  const changes = [];
  const view = await mount({ draft: '', agentConfig: { busy: false, onChange: (...args) => changes.push(args), options: [
    { id: 'thinking', category: 'thought_level', name: 'Thinking', type: 'select', currentValue: 'deep', options: [{ value: 'quick', name: 'Quick' }, { value: 'deep', name: 'Deep' }] },
  ] } });
  try {
    await act(async () => view.host.querySelector('.composer-model').click());
    const rows = view.host.querySelectorAll('.model-reasoning-rows > button');
    assert.equal(rows.length, 1); assert.equal(rows[0].textContent, '推理Deep');
    await act(async () => rows[0].click());
    assert.equal(view.host.querySelector('[aria-label="自定义推理强度"]'), null);
    assert.equal(view.host.querySelector('[aria-label="快速模式"]'), null);
    await act(async () => view.host.querySelector('[aria-label="推理强度：Quick"]').click());
    assert.deepEqual(changes, [['thinking', 'quick']]);
  } finally { await view.close(); }
});

test('combined selector still filters model aliases and raw IDs', async () => {
  const view = await mount({ agentId: 'native', draft: '', providers: [{ id: 'custom', name: 'Custom', models: [{ name: 'namespace/first', displayName: 'Flash' }, { name: 'namespace/second', displayName: 'Pro' }] }] });
  try {
    await act(async () => view.host.querySelector('.composer-model').click());
    await act(async () => view.host.querySelector('.model-reasoning-rows > button').click());
    const search = view.host.querySelector('[aria-label="搜索模型或供应商"]');
    await act(async () => Simulate.change(search, { target: { value: 'second' } }));
    assert.deepEqual([...view.host.querySelectorAll('[role="radio"]')].map(row => row.getAttribute('aria-label')), ['Custom / Pro']);
    await act(async () => Simulate.change(search, { target: { value: 'missing' } }));
    assert.match(view.host.querySelector('.composer-empty').textContent, /没有找到匹配的模型/);
  } finally { await view.close(); }
});


test('hover opens sibling flyouts and keeps the compact main menu visible', async () => {
  const view = await mount({ agentId: 'native', draft: '', providers: [{ id: 'custom', name: 'Custom', models: [{ name: 'first', displayName: 'Flash' }] }] });
  try {
    await act(async () => view.host.querySelector('.composer-model').click());
    const modelRow = view.host.querySelector('.model-reasoning-rows > button:first-child');
    const effortRow = view.host.querySelector('.model-reasoning-rows > button:last-child');
    await act(async () => Simulate.pointerEnter(modelRow, { pointerType: 'mouse' }));
    assert.ok(view.host.querySelector('.model-reasoning-flyout [aria-label="搜索模型或供应商"]'));
    assert.equal(view.host.querySelectorAll('.model-reasoning-rows > button').length, 2);
    assert.equal(modelRow.getAttribute('aria-expanded'), 'true');
    const search = view.host.querySelector('[aria-label="搜索模型或供应商"]');
    await act(async () => Simulate.change(search, { target: { value: 'Flash' } }));
    await act(async () => Simulate.pointerEnter(modelRow, { pointerType: 'mouse' }));
    assert.equal(search.value, 'Flash', 'reentering the same row preserves the model search');
    await act(async () => Simulate.pointerEnter(effortRow, { pointerType: 'mouse' }));
    assert.ok(view.host.querySelector('.model-reasoning-flyout .effort-body'));
    assert.equal(view.host.querySelector('[aria-label="搜索模型或供应商"]'), null);
    assert.equal(modelRow.getAttribute('aria-expanded'), 'false');
    assert.equal(effortRow.getAttribute('aria-expanded'), 'true');
    assert.equal(view.host.querySelectorAll('.model-reasoning-rows > button').length, 2);
    await act(async () => Simulate.pointerEnter(modelRow, { pointerType: 'touch' }));
    assert.ok(view.host.querySelector('.effort-body'), 'touch opens a submenu only on tap');
  } finally { await view.close(); }
});

test('MCP toolbar manages the current Agent, persists changes, and retains state on save failure', async () => {
  let servers = [
    { name: 'docs', type: 'stdio', source: 'global', configuredEnabled: true, enabled: true },
    { name: 'project', type: 'http', source: 'project', configuredEnabled: false, enabled: false },
  ];
  const writes = []; let failure = false;
  const api = { async request(path, method, body) {
    if (!path.startsWith('/agent-engines/mcp')) return [];
    if (method === 'PUT') {
      writes.push(body);
      if (failure) throw new Error('保存失败');
      servers = servers.map(server => server.name === body.name ? { ...server, enabled: body.enabled } : server);
    }
    return servers;
  } };
  const view = await mount({ draft: '', api });
  try {
    const button = view.host.querySelector('[aria-label="管理 MCP 透传"]');
    assert.ok(button);
    await act(async () => button.click());
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.equal(view.host.querySelector('.composer-mcp-controls .composer-note'), null);
    assert.equal(view.host.querySelector('.composer-mcp-list small'), null);
    const projectToggle = () => view.host.querySelector('[aria-label="透传 MCP：project"]');
    assert.equal(projectToggle().disabled, false);
    assert.equal(projectToggle().checked, false);
    const toggle = () => view.host.querySelector('[aria-label="透传 MCP：docs"]');
    assert.equal(toggle().checked, true);
    await act(async () => Simulate.change(toggle(), { target: { checked: false } }));
    assert.deepEqual(writes, [{ agentId: 'codex', workspaceHash: 'workspace', name: 'docs', enabled: false }]);
    assert.equal(toggle().checked, false);
    assert.match(view.host.querySelector('.popover-footer').textContent, /下一轮生效/);
    await act(async () => Simulate.change(projectToggle(), { target: { checked: true } }));
    assert.deepEqual(writes.at(-1), { agentId: 'codex', workspaceHash: 'workspace', name: 'project', enabled: true });
    assert.equal(projectToggle().checked, true);
    failure = true;
    await act(async () => Simulate.change(toggle(), { target: { checked: true } }));
    assert.equal(toggle().checked, false);
    assert.match(view.host.querySelector('[role="alert"]').textContent, /保存失败/);
    await view.update({ agentId: 'native' });
    assert.equal(view.host.querySelector('.composer-mcp-controls'), null, 'Agent switch closes stale controls');
    await view.update({ chatMode: true });
    assert.equal(view.host.querySelector('[aria-label="管理 MCP 透传"]'), null);
  } finally { await view.close(); }
});
