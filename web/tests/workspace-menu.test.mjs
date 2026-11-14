import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// The project switcher sits at the bottom of the welcome screen. Its menu used
// to always open upward without a height cap, so a long project list ran past
// the top of the window. It now opens upward by default, is capped to the room
// above (the list scrolls) and only flips below the switcher when that room is
// unusable. The heading and 「管理项目」stay fixed either way.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });

const { act, createElement, useEffect, useState } = await import('react');
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
const { computeMenuPlacement } = await import(placementUrl);
const iconStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
const Icon = () => null;
export const Check = Icon;
export const ChevronDown = Icon;
export const Bot = Icon;
export const FolderClosed = Icon;
export const FolderPlus = Icon;
export const MessageCircle = Icon;
`);
const motionStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const Enter = ({ children }) => children;
export const Popup = ({ open, children, className }) => open ? createElement('div', { className }, children) : null;
`);
const uiStub = dataUrl('export const LoopraMark = () => null; export const LoadingSkeleton = () => null;');
const nextuiStub = dataUrl('export const Button = () => null, Modal = () => null, ModalBody = () => null, ModalContent = () => null, ModalFooter = () => null, ModalHeader = () => null;');
const switcherUrl = await sourceUrl('layout/AgentSwitcher.tsx', {
  'lucide-react': iconStub,
  '@nextui-org/react': nextuiStub,
  '../components/Motion': motionStub,
  '../components/AgentIcon': await sourceUrl('components/AgentIcon.tsx'),
  '../agent-install': await sourceUrl('agent-install.ts'),
  './menu-placement': placementUrl,
});

const homeUrl = await sourceUrl('layout/HomeView.tsx', {
  'lucide-react': iconStub,
  '../components/Motion': motionStub,
  '../components/ui': uiStub,
  './AgentSwitcher': switcherUrl,
  './menu-placement': placementUrl,
});
const { default: HomeView } = await import(homeUrl);
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const appAst = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const app = appAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'App');
const dismissEffect = app.body.statements.find(node => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression) && node.expression.expression.getText(appAst) === 'useEffect'
  && node.expression.arguments[0].getText(appAst).includes('function onPointer'));
const pointerFunction = dismissEffect.expression.arguments[0].body.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'onPointer');
const pointerCode = ts.transpileModule(pointerFunction.getText(appAst), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const bindPointer = new Function('menu', 'setMenu', `${pointerCode}; return onPointer;`);

function ruleBody(css, selector) {
  const pattern = new RegExp('^[ \\t]*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]*)\\}', 'm');
  const match = css.match(pattern);
  assert.ok(match, `missing CSS rule: ${selector}`);
  return match[1];
}

const workspaces = Array.from({ length: 20 }, (_, index) => ({ hash: `h${index}`, name: `project-${index}` }));

const rectOf = ({ top, bottom }) => ({ top, bottom, left: 0, right: 1500, width: 1500, height: bottom - top, x: 0, y: top, toJSON() {} });

async function mount(rect, viewportHeight, clip, overrides = {}) {
  const original = dom.window.Element.prototype.getBoundingClientRect;
  Object.defineProperty(dom.window, 'innerHeight', { configurable: true, value: viewportHeight });
  dom.window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.classList?.contains('workspace-selector')) return rectOf(rect);
    if (this.classList?.contains('clip-pane')) return rectOf(clip);
    return rectOf({ top: 0, bottom: viewportHeight });
  };
  const container = document.createElement('div');
  document.body.append(container);
  // Mirrors the home pane: an `overflow: hidden` ancestor whose top edge sits
  // below the header, which is what really limits an upward menu.
  const host = clip ? document.createElement('div') : container;
  if (clip) { host.className = 'clip-pane'; host.style.overflow = 'hidden'; container.append(host); }
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(HomeView, {
      workspaces, workspace: 'h0', workspaceName: 'project-0', menuOpen: true,
      onToggleMenu() {}, onSelect() {}, onManage() {}, engines: [], agentId: 'native', agentDisabled: false, onAgent() {},
      ...overrides,
    }, null)));
  } finally {
    dom.window.Element.prototype.getBoundingClientRect = original;
  }
  return {
    anchor: container.querySelector('.workspace-selector'),
    menu: container.querySelector('.popup.workspace-menu'),
    async close() { await act(async () => root.unmount()); container.remove(); },
  };
}

const windowBounds = height => ({ top: 0, bottom: height });

async function mountInteractive() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const selected = [];
  let managed = 0;
  function Harness() {
    const [menu, setMenu] = useState(null);
    useEffect(() => {
      const pointer = bindPointer(menu, setMenu);
      document.addEventListener('pointerdown', pointer);
      return () => document.removeEventListener('pointerdown', pointer);
    }, [menu]);
    return createElement(HomeView, {
      workspaces, workspace: 'h0', workspaceName: 'project-0', menuOpen: menu === 'workspace',
      onToggleMenu: () => setMenu(current => current === 'workspace' ? null : 'workspace'),
      onSelect: hash => { selected.push(hash); setMenu(null); },
      onManage: () => { managed++; setMenu(null); },
      engines: [{ id: 'native', name: 'Loopra Native', available: true }],
      agentId: 'native', agentDisabled: false, onAgent() {},
    }, createElement('div', { className: 'rich-composer', 'data-popover': '' },
      createElement('textarea', { 'aria-label': '输入消息' }),
      createElement('button', { 'aria-label': '常用要求' }, '要求')));
  }
  await act(async () => root.render(createElement(Harness)));
  return {
    container, selected, managed: () => managed,
    menu: () => container.querySelector('.workspace-selector > .workspace-menu'),
    async pointer(target) { await act(async () => target.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }))); },
    async click(selector) {
      const target = container.querySelector(selector);
      await act(async () => target.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true })));
      await act(async () => target.click());
    },
    async close() { await act(async () => root.unmount()); container.remove(); },
  };
}

test('workspace menu dismisses from the message input, other composer controls and page', async () => {
  const view = await mountInteractive();
  try {
    for (const selector of ['textarea', '.rich-composer', '[aria-label="常用要求"]', '.welcome-switchers', 'body']) {
      await view.click('.workspace-selector > button');
      assert.ok(view.menu());
      await view.pointer(selector === 'body' ? document.body : view.container.querySelector(selector));
      assert.ok(!view.menu(), `clicking ${selector} dismisses the workspace menu`);
    }
  } finally { await view.close(); }
});

test('workspace menu preserves internal interactions and the trigger toggles instead of reopening', async () => {
  const view = await mountInteractive();
  try {
    await view.click('.workspace-selector > button');
    await view.pointer(view.menu().querySelector('h3'));
    await view.pointer(view.menu().querySelector('.workspace-menu-list'));
    assert.ok(view.menu(), 'heading and scrolling list are inside the current menu');
    await view.click('.workspace-selector > button');
    assert.ok(!view.menu(), 'pressing the active trigger closes the menu');
    await view.click('.workspace-selector > button');
    await view.click('.workspace-menu-list > button:nth-child(2)');
    assert.deepEqual(view.selected, ['h1']);
    assert.ok(!view.menu());
    await view.click('.workspace-selector > button');
    await view.click('.workspace-selector > .workspace-menu > button');
    assert.equal(view.managed(), 1);
    assert.ok(!view.menu());
  } finally { await view.close(); }
});

test('switching between workspace and Agent menus leaves only the clicked menu open', async () => {
  const view = await mountInteractive();
  try {
    await view.click('.workspace-selector > button');
    await view.click('[aria-label="选择 Agent"]');
    assert.ok(!view.menu(), 'the Agent trigger is outside the workspace menu');
    assert.ok(view.container.querySelector('.agent-menu'));
    await view.click('.workspace-selector > button');
    assert.ok(view.menu());
    assert.ok(!view.container.querySelector('.agent-menu'), 'the workspace trigger is outside the Agent menu');
  } finally { await view.close(); }
});

test('placement prefers the top and only flips down when it cannot be used', () => {
  // The switcher sits low in a 753px window, but the room above still fits a
  // usable menu, so it keeps opening upward with a scrollable, capped list.
  assert.deepEqual(computeMenuPlacement({ top: 324, bottom: 340 }, windowBounds(753)), { side: 'top', maxHeight: 309 });
  // With plenty of room above the menu stays above it.
  assert.deepEqual(computeMenuPlacement({ top: 700, bottom: 720 }, windowBounds(753)), { side: 'top', maxHeight: 685 });
  // Near the top of the window the space above is unusable, so it flips down.
  assert.deepEqual(computeMenuPlacement({ top: 60, bottom: 80 }, windowBounds(753)), { side: 'bottom', maxHeight: 658 });
  // …unless the space below is even smaller, in which case the top still wins.
  assert.deepEqual(computeMenuPlacement({ top: 100, bottom: 300 }, windowBounds(320)), { side: 'top', maxHeight: 85 });
  // Never hand back negative space on a viewport shorter than the anchor; a tie
  // keeps the historical upward direction.
  assert.deepEqual(computeMenuPlacement({ top: 4, bottom: 4 }, windowBounds(10)), { side: 'top', maxHeight: 0 });
  // The home pane clips at 48px (below the header) and ends at 660px: the menu
  // must fit between those edges, not between the window edges.
  assert.deepEqual(computeMenuPlacement({ top: 324, bottom: 340 }, { top: 48, bottom: 660 }), { side: 'top', maxHeight: 261 });
});

test('the menu mounts upward when that side is usable and caps itself to it', async () => {
  const view = await mount({ top: 324, bottom: 340 }, 753);
  try {
    assert.equal(view.anchor.dataset.placement, 'top');
    assert.equal(view.anchor.style.getPropertyValue('--menu-max-height'), '309px');
    const list = view.menu.querySelector('.workspace-menu-list');
    assert.equal(list.querySelectorAll('button').length, workspaces.length);
    // The footer action and divider stay outside the scrolling region.
    const manage = [...view.menu.querySelectorAll('button')].find(button => button.textContent.includes('管理项目'));
    assert.equal(manage.parentElement, view.menu);
    assert.equal(view.menu.querySelector('hr').parentElement, view.menu);
    assert.equal(view.menu.querySelector('h3').parentElement, view.menu);
  } finally { await view.close(); }
});

test('an overflow-hidden pane bounds the menu so its heading is never clipped', async () => {
  // The home pane starts 48px below the window top; measuring against the
  // window let the heading slide under that clip.
  const view = await mount({ top: 324, bottom: 340 }, 753, { top: 48, bottom: 660 });
  try {
    assert.equal(view.anchor.dataset.placement, 'top');
    assert.equal(view.anchor.style.getPropertyValue('--menu-max-height'), '261px');
  } finally { await view.close(); }
});

test('pure chat keeps project management reachable even without any projects', async () => {
  let managed = false;
  const view = await mount({ top: 324, bottom: 340 }, 753, undefined, {
    chatMode: true, workspace: 'chat', workspaceName: '纯聊天',
    workspaces: [{ hash: 'chat', name: '纯聊天', path: '', kind: 'chat' }],
    onManage: () => { managed = true; },
  });
  try {
    assert.equal(view.menu.querySelectorAll('.workspace-menu-list button').length, 1);
    const manage = [...view.menu.querySelectorAll('button')].find(button => button.textContent.includes('管理项目'));
    assert.ok(manage);
    await act(async () => manage.click());
    assert.equal(managed, true);
    assert.ok(view.menu.querySelector('hr'));
  } finally { await view.close(); }
});

test('a low switcher keeps the menu above it', async () => {
  const view = await mount({ top: 700, bottom: 720 }, 753);
  try {
    assert.equal(view.anchor.dataset.placement, 'top');
    assert.equal(view.anchor.style.getPropertyValue('--menu-max-height'), '685px');
  } finally { await view.close(); }
});

test('a switcher with no usable room above flips the menu below', async () => {
  const view = await mount({ top: 40, bottom: 60 }, 300);
  try {
    assert.equal(view.anchor.dataset.placement, 'bottom');
    assert.equal(view.anchor.style.getPropertyValue('--menu-max-height'), '225px');
  } finally { await view.close(); }
});

test('the popup is a capped column and only the list scrolls', () => {
  const menu = ruleBody(styles, '.workspace-menu');
  assert.match(menu, /max-height:\s*var\(--menu-max-height/);
  assert.match(menu, /display:\s*flex/);
  assert.match(menu, /flex-direction:\s*column/);
  // Shared by the project and Agent switchers: both are `menu-anchor`s.
  const flipped = ruleBody(styles, '.menu-anchor[data-placement="bottom"] > .workspace-menu');
  assert.match(flipped, /top:\s*calc\(100% \+ 0\.4375rem\)/);
  assert.match(flipped, /bottom:\s*auto/);
  // The composer sits in a z-index:12 stacking context, so the open anchor has
  // to outrank it or the flipped menu is painted underneath the input box.
  assert.match(ruleBody(styles, '.menu-anchor:has(> .workspace-menu)'), /z-index:\s*20/);
  const list = ruleBody(styles, '.workspace-menu-list');
  assert.match(list, /flex:\s*1 1 auto/);
  assert.match(list, /min-height:\s*0/);
  assert.match(list, /overflow-y:\s*auto/);
  assert.match(list, /overscroll-behavior:\s*contain/);
});
