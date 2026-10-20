import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const dom = new JSDOM('<html><body></body></html>', { url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
async function moduleUrl(name, imports = {}) {
  const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
  for (const [name, url] of Object.entries({ 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), ...imports })) {
    outputText = outputText.replaceAll(`'${name}'`, JSON.stringify(url)).replaceAll(`"${name}"`, JSON.stringify(url));
  }
  return dataUrl(outputText);
}
const agentConfigUrl = await moduleUrl('agent-config.ts');
const { default: Controls } = await import(await moduleUrl('components/AgentConfigControls.tsx', {
  '../agent-config': agentConfigUrl,
  'lucide-react': import.meta.resolve('lucide-react'),
}));
const { agentEffortLevels, agentModelGroups, findAgentOption, isDangerousAgentMode, agentOptionLabel, applySeed, newSessionSeed, seedChanges } = await import(agentConfigUrl);
function render(state, options = state.options) {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const update = (nextState, nextOptions = nextState.options) => act(() => root.render(createElement(Controls, { state: nextState, options: nextOptions })));
  update(state, options);
  return { container, update, close: () => { act(() => root.unmount()); container.remove(); } };
}
const click = element => act(() => element.click());

test('Agent-specific selects render as the shared radio list and only change on click', () => {
  const changes = [];
  const state = { busy: false, onPrepare() {}, onChange: (...args) => changes.push(args), options: [
    { id: 'agent', name: 'Agent', category: 'agent', type: 'select', currentValue: 'standard', options: [{ value: 'standard', name: 'Standard', description: 'Default persona' }, { value: 'review', name: 'Reviewer', description: 'Read-only review' }] },
  ] };
  const view = render(state);
  try {
    assert.deepEqual(changes, []);
    assert.equal(view.container.querySelectorAll('select').length, 0, 'Agent options must reuse composer controls instead of raw selects');
    const radios = view.container.querySelectorAll('button[role="radio"]');
    assert.equal(radios.length, 2);
    assert.equal(radios[0].getAttribute('aria-checked'), 'true');
    assert.match(radios[0].textContent, /Standard/);
    assert.match(radios[0].textContent, /Default persona/);
    click(radios[1]);
    assert.deepEqual(changes, [['agent', 'review']]);
  } finally { view.close(); }
});

test('boolean options keep their type and pending requests disable every choice', () => {
  const changes = [];
  const state = { busy: false, onPrepare() {}, onChange: (...args) => changes.push(args), options: [
    { id: 'fast_mode', name: 'Fast mode', type: 'boolean', currentValue: false, options: [] },
  ] };
  const view = render(state);
  try {
    const toggle = view.container.querySelector('button[role="switch"]');
    assert.equal(toggle.getAttribute('aria-checked'), 'false');
    click(toggle);
    assert.deepEqual(changes, [['fast_mode', true]]);
    view.update({ ...state, busy: true }, [{ ...state.options[0], currentValue: true }]);
    assert.equal(view.container.querySelector('button[role="switch"]').getAttribute('aria-checked'), 'true');
    assert.equal(view.container.querySelector('button[role="switch"]').disabled, true);
  } finally { view.close(); }
});

test('an existing value outside the picker stays visible without silently choosing another', () => {
  const view = render({ busy: false, onPrepare() {}, onChange() { assert.fail('Must not change the Agent default'); }, options: [
    { id: 'agent', name: 'Agent', type: 'select', currentValue: 'custom-current', options: [{ value: 'other', name: 'Other' }] },
  ] });
  try {
    const selected = [...view.container.querySelectorAll('button[role="radio"]')].filter(button => button.getAttribute('aria-checked') === 'true');
    assert.equal(selected.length, 1);
    assert.match(selected[0].textContent, /custom-current/);
  } finally { view.close(); }
});

test('ACP categories drive the shared permission, model and effort controls', () => {
  const options = [
    { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'bypassPermissions', options: [
      { value: 'default', name: 'Manual' }, { value: 'bypassPermissions', name: 'Bypass permissions' }] },
    { id: 'model-picker', name: 'Model', category: 'model', type: 'select', currentValue: 'opus', options: [
      { value: 'default', name: 'default' },
      { value: 'opus', name: 'Opus', group: 'Claude' },
      { value: 'sonnet', name: 'Sonnet', group: 'Claude' }] },
    { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'default', options: [
      { value: 'default', name: 'Default' }, { value: 'max', name: 'Max' }] },
  ];
  assert.equal(findAgentOption(options, 'model', 'model')?.id, 'model-picker');
  assert.equal(findAgentOption(options, 'not-there', 'mode')?.id, 'mode');
  const model = findAgentOption(options, 'model', 'model');
  assert.deepEqual(agentModelGroups(model, 'Claude Code').map(group => [group.name, group.models.map(value => value.name)]),
    [['Claude Code', ['default']], ['Claude', ['Opus', 'Sonnet']]]);
  assert.deepEqual(agentEffortLevels(findAgentOption(options, 'effort')).map(level => level.label), ['默认', '最大']);
  assert.equal(agentOptionLabel(findAgentOption(options, 'mode')), 'Bypass permissions');
  assert.equal(isDangerousAgentMode(findAgentOption(options, 'mode')), true);
  assert.equal(isDangerousAgentMode({ ...findAgentOption(options, 'mode'), currentValue: 'default' }), false);
  assert.equal(isDangerousAgentMode({ ...findAgentOption(options, 'mode'), currentValue: 'agent-full-access' }), true);
  assert.equal(isDangerousAgentMode({ ...findAgentOption(options, 'mode'), currentValue: 'workspace-write' }), false);
});

test('Native channel and model names split into the same grouped model list', () => {
  const option = { id: 'model', name: '模型', category: 'model', type: 'select', currentValue: 'one:alpha', options: [
    { value: 'one:alpha', name: 'one / alpha' }, { value: 'one:beta', name: 'one / beta' }, { value: 'two:gamma', name: 'two / gamma' }] };
  assert.deepEqual(agentModelGroups(option, 'Loopra Native').map(group => [group.name, group.models.map(value => value.name)]),
    [['one', ['alpha', 'beta']], ['two', ['gamma']]]);
});

test('a new conversation inherits the last new conversation\'s choices', () => {
  const chosen = [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'remote-magpie/group/auto-deep', options: [
      { value: 'default', name: 'Default' }, { value: 'remote-magpie/group/auto-deep', name: 'auto-deep' }] },
    { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'bypassPermissions', options: [
      { value: 'default', name: 'Manual' }, { value: 'bypassPermissions', name: 'Bypass permissions' }] },
    { id: 'plan', type: 'select', currentValue: 'on', options: [{ value: 'off', name: 'Off' }, { value: 'on', name: 'On' }] },
    { id: 'fast', type: 'boolean', currentValue: false, options: [] },
  ];
  // Plan mode is turn-scoped and never carried into a new conversation.
  assert.deepEqual(newSessionSeed(chosen), { model: 'remote-magpie/group/auto-deep', mode: 'bypassPermissions', fast: false });

  const prepared = [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'default', options: [
      { value: 'default', name: 'Default' }, { value: 'remote-magpie/group/auto-deep', name: 'auto-deep' }] },
    { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: [
      { value: 'default', name: 'Manual' }, { value: 'bypassPermissions', name: 'Bypass permissions' }] },
    { id: 'plan', type: 'select', currentValue: 'off', options: [{ value: 'off', name: 'Off' }, { value: 'on', name: 'On' }] },
    { id: 'fast', type: 'boolean', currentValue: true, options: [] },
  ];
  assert.deepEqual(seedChanges(prepared, newSessionSeed(chosen)), [
    { id: 'model', value: 'remote-magpie/group/auto-deep' },
    { id: 'mode', value: 'bypassPermissions' },
    { id: 'fast', value: false },
  ]);
  // Values the Agent no longer offers are skipped rather than failing the draft.
  assert.deepEqual(seedChanges(prepared, { model: 'retired-model', mode: 'gone', fast: 'yes' }), []);
  // Equal values need no round trip.
  assert.deepEqual(seedChanges(prepared, { model: 'default', fast: true }), []);
  // The local preview already shows the remembered choices, so the factory
  // default never flashes while the writes are in flight.
  const preview = applySeed(prepared, newSessionSeed(chosen));
  assert.deepEqual(preview.map(option => [option.id, option.currentValue]), [
    ['model', 'remote-magpie/group/auto-deep'], ['mode', 'bypassPermissions'], ['plan', 'off'], ['fast', false],
  ]);
  // Plan mode and retired values are never applied to the preview either.
  assert.deepEqual(applySeed(prepared, { plan: 'on', model: 'retired' }).map(option => option.currentValue), ['default', 'default', 'off', true]);
});

test('a fresh draft applies the remembered choices, while a session keeps its own', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /useLocalState<Record<string, Record<string, string \| boolean>>>\('new-session-config'/);
  // Seeding runs in the background so the home composer shows its controls at once…
  assert.match(app, /seeding = seedNewConfig\(workspaceHash, prepared\.sessionName/);
  assert.match(app, /storeNewAgentConfig\(\{ key, options: applySeed\(prepared\.configOptions/);
  // …and the first send waits for it, so the turn never starts on factory defaults.
  assert.match(app, /await newConfigSeed\.current\?\.catch\(\(\) => \{\}\);/);
  assert.match(app, /session \? prepared\.configOptions\s*: await seedNewConfig/);
  assert.match(app, /if \(!session\) rememberFallbackConfig\(target\.agentId \|\| agentId, next\)/);
  assert.match(app, /rememberNewConfig\(target\.agentId \|\| agentId, result\.configOptions\)/);
  // The last preset is cached so the composer can show it disabled while the
  // Agent reconnects, then swap in the authoritative options.
  assert.match(app, /useLocalState<Record<string, AgentConfigOption\[\]>>\('agent-config-cache'/);
  assert.match(app, /newAgentConfig\?\.key === agentConfigKey \? newAgentConfig\.options : agentConfigCache\[newConfigKey\(agentId\)\]/);
  assert.match(app, /const composerConfigBusy = !!agentConfigBusy \|\| \(!session && newAgentConfig\?\.key !== agentConfigKey\)/);
  assert.match(app, /busy: composerConfigBusy/);
  assert.match(app, /cacheAgentConfig\(prepared\.agentId, options\)/);
});

test('the agent switcher sits beside the project switcher and locks while running', async () => {
  const [home, switcher, app, composer] = await Promise.all([
    readFile(new URL('../src/layout/HomeView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/layout/AgentSwitcher.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/Composer.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(home, /className="welcome-switchers"/);
  assert.match(home, /<AgentSwitcher engines=\{engines\}/);
  assert.match(switcher, /disabled=\{disabled\}/);
  assert.match(switcher, /任务运行中，结束后才能切换 Agent/);
  assert.match(app, /agentDisabled=\{!!generatingId \|\| !!remoteRun\}/);
  assert.match(app, /if \(generatingId \|\| remoteRun\) \{ notify\('任务运行中，结束后才能切换 Agent'\); return; \}/);
  // Agent switching lives beside the project switcher on the home screen only.
  // A conversation keeps the Agent it was created with, so the composer has no switcher.
  assert.doesNotMatch(composer, /aria-label="选择 Agent"/);
  assert.doesNotMatch(composer, /menu === 'agents'/);
});

test('missing external runtimes offer provider-specific copyable install prompts', async () => {
  const [switcher, home, app] = await Promise.all([
    readFile(new URL('../src/layout/AgentSwitcher.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/layout/HomeView.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  ]);
  // Only the unavailable external engine gets the inline action; Native stays clickable.
  assert.match(switcher, /!engine\.available && !!agentAcpInstallPrompt\(engine\.id\)/);
  assert.match(switcher, /className="agent-install"/);
  assert.match(switcher, /复制提示词/);
  assert.match(switcher, /const text = agentAcpInstallPrompt\(installing\?\.id \|\| ''\)/);
  assert.match(switcher, /navigator\.clipboard\.writeText\(text\)/);
  // Unfocused Electron documents reject the async clipboard API; keep the
  // selection-based fallback so the copy action still works.
  assert.match(switcher, /document\.execCommand\('copy'\)/);
  // The backend detects runtimes per request, so opening the menu re-checks
  // whether the just-installed dependency is visible.
  assert.match(switcher, /onRefreshEngines\?\.\(\)/);
  assert.match(home, /onRefreshEngines=\{onRefreshEngines\}/);
  assert.match(app, /enginesRevision/);
  const { agentAcpInstallPrompt } = await import(await moduleUrl('agent-install.ts'));
  const prompt = agentAcpInstallPrompt('claude-code');
  assert.match(prompt, /Node\.js 22\+/);
  assert.match(prompt, /Claude Code/);
  assert.match(prompt, /@agentclientprotocol\/claude-agent-acp/);
  // Ask what is missing instead of dictating commands: the receiving Agent knows
  // how to detect and install these packages.
  assert.match(prompt, /检查[^\n]*是否已安装/);
  assert.doesNotMatch(prompt, /npm install/);
  // The adapter tracks its own releases; do not pin a version in the prompt.
  assert.doesNotMatch(prompt, /claude-agent-acp@\d/);
  const codex = agentAcpInstallPrompt('codex');
  assert.match(codex, /Node\.js 22\+/);
  assert.match(codex, /@agentclientprotocol\/codex-acp/);
  assert.match(codex, /自带兼容的 Codex CLI/);
  assert.doesNotMatch(codex, /Claude|@zed-industries/);
  assert.equal(agentAcpInstallPrompt('native'), '');
  assert.equal(agentAcpInstallPrompt('unknown'), '');
});

test('a draft session can manage its isolation environment before the first message', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  // The prepared draft is a real backend session, so the Git tab can toggle its
  // worktree mode even though no message has been sent yet.
  assert.match(app, /sessionName=\{session\?\.name \|\| \(isHome \? preparedNewSession\.current\?\.target\.name : undefined\)\}/);
  // Switching isolation discards the draft's process, so selection must not race the
  // first prompt with a redundant configuration read that would report "正在运行".
  assert.match(app, /seededConfigAt\.current\[target!\.id\] = Date\.now\(\)/);
  assert.match(app, /Date\.now\(\) - seededAt < 5000/);
});
