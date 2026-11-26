import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { reactI18nextStubUrl } from './i18n-test-utils.mjs';

// The Agent chooser shares the project menu's placement rules: upward by
// default, capped to the room its clipping pane leaves, flipped below only when
// that side is unusable. Engine rows come first, custom-agent personas below.
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
  for (const [specifier, url] of Object.entries({ react: reactUrl, 'react-i18next': reactI18nextStubUrl, 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'), ...dependencies })) {
    outputText = outputText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
  }
  return dataUrl(outputText);
}

const placementUrl = await sourceUrl('layout/menu-placement.ts');
const iconStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
const Icon = () => null;
export const Bot = Icon;
export const Check = Icon;
export const ChevronDown = Icon;
`);
const motionStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const Popup = ({ open, children, className }) => open ? createElement('div', { className }, children) : null;
`);
const personaIconDeps = {
  'lucide-react': iconStub,
  './plugin-icons': dataUrl('export const lucideIcons = {};'),
  '../custom-agents': dataUrl(`export const isAgentIconImage = icon => icon.startsWith('data:image/');`),
};

const switcherUrl = await sourceUrl('layout/AgentSwitcher.tsx', {
  'lucide-react': iconStub,
  '../components/Motion': motionStub,
  '../components/AgentIcon': await sourceUrl('components/AgentIcon.tsx', personaIconDeps),
  './menu-placement': placementUrl,
});
const { default: AgentSwitcher } = await import(switcherUrl);
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');

function ruleBody(css, selector) {
  const pattern = new RegExp('^[ \\t]*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]*)\\}', 'm');
  const match = css.match(pattern);
  assert.ok(match, `missing CSS rule: ${selector}`);
  return match[1];
}

const engines = Array.from({ length: 8 }, (_, index) => ({
  id: index === 0 ? 'native' : `engine-${index}`,
  name: index === 0 ? 'Loopra Native' : `Agent ${index}`,
  detail: '使用本机登录和配置',
  available: true,
}));
const rectOf = ({ top, bottom }) => ({ top, bottom, left: 0, right: 1500, width: 1500, height: bottom - top, x: 0, y: top, toJSON() {} });

async function mount(rect, viewportHeight, props = {}) {
  const original = dom.window.Element.prototype.getBoundingClientRect;
  Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: viewportHeight });
  dom.window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.classList?.contains('agent-selector')) return rectOf(rect);
    return rectOf({ top: 0, bottom: viewportHeight });
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(AgentSwitcher, {
      engines, agentId: 'native', disabled: false, onSelect() {}, ...props,
    })));
    await act(async () => { container.querySelector('.agent-selector > button').click(); });
  } finally {
    dom.window.Element.prototype.getBoundingClientRect = original;
  }
  return {
    container,
    anchor: container.querySelector('.agent-selector'),
    menu: container.querySelector('.popup.agent-menu'),
    async close() { await act(async () => root.unmount()); container.remove(); },
  };
}

test('the agent menu opens upward with the measured room and omits redundant hints', async () => {
  const view = await mount({ top: 324, bottom: 340 }, 753);
  try {
    assert.equal(view.anchor.dataset.placement, 'top');
    assert.equal(view.anchor.style.getPropertyValue('--menu-max-height'), '309px');
    const list = view.menu.querySelector('.composer-tool-list');
    assert.equal(list.querySelectorAll('.agent-option').length, engines.length);
    assert.equal(view.menu.querySelector('h3').textContent, '选择 Agent');
    assert.equal(view.menu.querySelector('.composer-note'), null);
    assert.equal(view.menu.querySelector('small'), null);
  } finally { await view.close(); }
});

test('a switcher with no usable room above opens the agent menu below', async () => {
  const view = await mount({ top: 40, bottom: 60 }, 300);
  try {
    assert.equal(view.anchor.dataset.placement, 'bottom');
    assert.equal(view.anchor.style.getPropertyValue('--menu-max-height'), '225px');
  } finally { await view.close(); }
});

test('the agent list is the only scrolling part of the menu', () => {
  const list = ruleBody(styles, '.agent-menu .composer-tool-list');
  assert.match(list, /flex:\s*1 1 auto/);
  assert.match(list, /min-height:\s*0/);
  assert.match(list, /overflow-y:\s*auto/);
  assert.match(list, /overscroll-behavior:\s*contain/);
  assert.doesNotMatch(styles, /^\.agent-menu > \.composer-note\s*\{/m);
});

// Missing or hidden engines are managed under 设置 → 外部 Agent; the chooser
// only lists usable engines plus the current selection.
test('unavailable or hidden engines stay out of the chooser', async () => {
  const view = await mount({ top: 400, bottom: 420 }, 800, {
    engines: [
      { id: 'native', name: 'Loopra Native', available: true },
      { id: 'codex', name: 'Codex', available: false, detail: '未找到 Codex ACP 适配器' },
      { id: 'devin', name: 'Devin', available: true, hidden: true },
      { id: 'claude-code', name: 'Claude Code', available: true },
    ],
    onSelect() { assert.fail('Only listed engines can be selected'); },
  });
  try {
    const rows = [...view.menu.querySelectorAll('.agent-option > button')].map(button => button.textContent);
    assert.deepEqual(rows, ['Loopra Native', 'Claude Code']);
  } finally { await view.close(); }
});

test('the selected engine stays listed after it becomes unavailable or hidden', async () => {
  const view = await mount({ top: 400, bottom: 420 }, 800, {
    agentId: 'codex',
    engines: [
      { id: 'native', name: 'Loopra Native', available: true },
      { id: 'codex', name: 'Codex', available: false, hidden: true, detail: '未找到 Codex ACP 适配器' },
    ],
    onSelect() { assert.fail('An unavailable engine must not be selected'); },
  });
  try {
    const rows = [...view.menu.querySelectorAll('.agent-option > button')];
    assert.deepEqual(rows.map(button => button.textContent), ['Loopra Native', 'Codex']);
    assert.equal(rows[1].disabled, true);
    assert.equal(rows[1].title, '未找到 Codex ACP 适配器');
  } finally { await view.close(); }
});

test('available Agent rows continue to select the engine', async () => {
  const selected = [];
  const view = await mount({ top: 400, bottom: 420 }, 800, { engines: [{ id: 'codex', name: 'Codex', available: true }], onSelect: id => selected.push(id) });
  try {
    await act(async () => view.menu.querySelector('.agent-option > button').click());
    assert.deepEqual(selected, ['codex']);
    assert.equal(view.container.querySelector('[role="dialog"]'), null);
  } finally { await view.close(); }
});

test('custom agent rows select and toggle the persona instead of an engine', async () => {
  const picked = [];
  const agents = [
    { id: 'agent_aaaaaaaaaaaa', name: '评审员', instruction: '只做代码评审' },
    { id: 'agent_bbbbbbbbbbbb', name: '翻译', instruction: '' },
  ];
  const view = await mount({ top: 400, bottom: 420 }, 800, { agents, customAgentId: 'agent_aaaaaaaaaaaa', onSelectAgent: id => picked.push(id) });
  try {
    const headings = [...view.menu.querySelectorAll('h3')].map(item => item.textContent);
    assert.deepEqual(headings, ['选择 Agent', '自定义智能体']);
    const rows = [...view.menu.querySelectorAll('.composer-tool-list')].at(-1).querySelectorAll('.agent-option > button');
    assert.equal(rows.length, agents.length);
    // 已选中的角色再次点击是取消绑定（传空串），而不是重复选择。
    await act(async () => rows[0].click());
    assert.deepEqual(picked, ['']);
  } finally { await view.close(); }
  const other = await mount({ top: 400, bottom: 420 }, 800, { agents, onSelectAgent: id => picked.push(id) });
  try {
    const rows = [...other.menu.querySelectorAll('.composer-tool-list')].at(-1).querySelectorAll('.agent-option > button');
    await act(async () => rows[1].click());
    assert.deepEqual(picked, ['', 'agent_bbbbbbbbbbbb']);
  } finally { await other.close(); }
});
