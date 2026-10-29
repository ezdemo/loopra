import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// The Agent chooser shares the project menu's placement rules: upward by
// default, capped to the room its clipping pane leaves, flipped below only when
// that side is unusable. The menu shows only the engine rows.
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

const placementUrl = await sourceUrl('layout/menu-placement.ts');
const iconStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
const Icon = () => null;
export const Check = Icon;
export const ChevronDown = Icon;
`);
const motionStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const Popup = ({ open, children, className }) => open ? createElement('div', { className }, children) : null;
`);
const nextuiStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const Button = ({ children, onPress }) => createElement('button', { type: 'button', onClick: onPress }, children);
export const Modal = ({ isOpen, children, 'aria-label': label }) => isOpen ? createElement('div', { role: 'dialog', 'aria-label': label }, children) : null;
export const ModalBody = ({ children }) => createElement('div', null, children);
export const ModalContent = ({ children }) => createElement('div', null, children);
export const ModalFooter = ({ children }) => createElement('div', null, children);
export const ModalHeader = ({ children }) => createElement('div', null, children);
`);
const installUrl = await sourceUrl('agent-install.ts');

const switcherUrl = await sourceUrl('layout/AgentSwitcher.tsx', {
  'lucide-react': iconStub,
  '@nextui-org/react': nextuiStub,
  '../components/Motion': motionStub,
  '../components/AgentIcon': await sourceUrl('components/AgentIcon.tsx'),
  '../agent-install': installUrl,
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

for (const engine of [
  { id: 'pi', name: 'Pi', available: false, detail: '未找到 Pi CLI', dependency: 'pi-coding-agent' },
  { id: 'dsh', name: 'DeepSeek Harness', available: false, detail: '未找到 DeepSeek Harness', dependency: '@deepseek-ai/dsh' },
]) {
  test(`${engine.name} row and install button open instructions without switching Agents`, async () => {
    const view = await mount({ top: 400, bottom: 420 }, 800, {
      engines: [engine], onSelect() { assert.fail('An unavailable engine must not be selected'); },
    });
    try {
      const row = view.menu.querySelector('.agent-option > button:first-child');
      assert.equal(row.disabled, false);
      assert.equal(row.title, engine.detail);
      assert.equal(row.textContent, engine.name);
      assert.equal(row.querySelector('small'), null);
      assert.equal(view.menu.querySelector('.agent-install').textContent, '安装说明');
      await act(async () => row.click());
      let dialog = view.container.querySelector('[role="dialog"]');
      assert.equal(dialog.getAttribute('aria-label'), `${engine.name} ACP 安装说明`);
      assert.ok(dialog.textContent.includes(engine.detail));
      assert.ok(dialog.querySelector('pre').textContent.includes(engine.dependency));
      await act(async () => [...dialog.querySelectorAll('button')].find(button => button.textContent === '关闭').click());
      assert.equal(view.container.querySelector('[role="dialog"]'), null);
      await act(async () => view.anchor.querySelector(':scope > button').click());
      await act(async () => view.anchor.querySelector('.agent-install').click());
      dialog = view.container.querySelector('[role="dialog"]');
      assert.ok(dialog.querySelector('pre').textContent.includes(engine.dependency));
    } finally { await view.close(); }
  });
}

test('available Agent rows continue to select the engine', async () => {
  const selected = [];
  const view = await mount({ top: 400, bottom: 420 }, 800, { engines: [{ id: 'codex', name: 'Codex', available: true }], onSelect: id => selected.push(id) });
  try {
    await act(async () => view.menu.querySelector('.agent-option > button').click());
    assert.deepEqual(selected, ['codex']);
    assert.equal(view.container.querySelector('[role="dialog"]'), null);
  } finally { await view.close(); }
});
