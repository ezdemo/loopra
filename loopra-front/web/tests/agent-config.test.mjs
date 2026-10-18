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
const { agentEffortLevels, agentModelGroups, findAgentOption, isDangerousAgentMode, agentOptionLabel } = await import(agentConfigUrl);
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
});

test('Native channel and model names split into the same grouped model list', () => {
  const option = { id: 'model', name: '模型', category: 'model', type: 'select', currentValue: 'one:alpha', options: [
    { value: 'one:alpha', name: 'one / alpha' }, { value: 'one:beta', name: 'one / beta' }, { value: 'two:gamma', name: 'two / gamma' }] };
  assert.deepEqual(agentModelGroups(option, 'Loopra Native').map(group => [group.name, group.models.map(value => value.name)]),
    [['one', ['alpha', 'beta']], ['two', ['gamma']]]);
});
