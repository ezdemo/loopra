import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// The 外部 Agent settings page manages third-party ACP agents: it shows each
// provider's detection result, offers the copyable install prompt for missing
// ones, and writes per-engine visibility to /agent-engines/preferences.
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

const iconStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const Bot = () => null;
`);
const nextuiStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const Button = ({ children, onPress, isDisabled, className }) => createElement('button', { type: 'button', disabled: !!isDisabled, className, onClick: onPress }, children);
export const Spinner = () => null;
export const Modal = ({ isOpen, children, 'aria-label': label }) => isOpen ? createElement('div', { role: 'dialog', 'aria-label': label }, children) : null;
export const ModalBody = ({ children }) => createElement('div', null, children);
export const ModalContent = ({ children }) => createElement('div', null, children);
export const ModalFooter = ({ children }) => createElement('div', null, children);
export const ModalHeader = ({ children }) => createElement('div', null, children);
`);
const controlsStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const PageActions = ({ title, children }) => createElement('header', null, createElement('h2', null, title), children || null);
export const SettingSwitch = ({ label, value, onChange }) => createElement('button', { type: 'button', role: 'switch', 'aria-label': label, 'aria-checked': String(value), onClick: () => onChange(!value) });
`);
const installUrl = await sourceUrl('agent-install.ts');
const pageUrl = await sourceUrl('components/ExternalAgentsPage.tsx', {
  '@nextui-org/react': nextuiStub,
  './AgentIcon': await sourceUrl('components/AgentIcon.tsx', {
    'lucide-react': iconStub,
    './plugin-icons': dataUrl('export const lucideIcons = {};'),
    '../custom-agents': dataUrl(`export const isAgentIconImage = icon => icon.startsWith('data:image/');`),
  }),
  './AgentInstallDialog': await sourceUrl('components/AgentInstallDialog.tsx', {
    '@nextui-org/react': nextuiStub,
    '../agent-install': installUrl,
  }),
  '../agent-install': installUrl,
  './RemoteControls': await sourceUrl('components/RemoteControls.tsx', { '@nextui-org/react': nextuiStub }),
  './SettingControls': controlsStub,
});
const { default: ExternalAgentsPage } = await import(pageUrl);

const enginesFixture = [
  { id: 'native', name: 'Loopra Native', available: true, detail: '', hidden: false },
  { id: 'claude-code', name: 'Claude Code', available: true, detail: '使用本机 Claude 登录和配置', hidden: false },
  { id: 'codex', name: 'Codex', available: false, detail: '未找到 Codex ACP 适配器', hidden: false },
  { id: 'devin', name: 'Devin', available: true, detail: '使用本机 Devin 登录和配置', hidden: true },
];

function backend(overrides = {}) {
  const calls = [];
  const api = {
    calls,
    request: async (path, method, body) => {
      calls.push({ path, method, body });
      if (overrides.fail?.(method)) throw new Error('保存失败');
      return method === 'PUT' ? { ok: true } : enginesFixture;
    },
  };
  return api;
}

async function mount(api, props = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(ExternalAgentsPage, { api, notify() {}, ...props })));
  await act(async () => {});
  return {
    container,
    rows: () => [...container.querySelectorAll('.setting-row')],
    async close() { await act(async () => root.unmount()); container.remove(); },
  };
}

test('every external engine gets a row with its detection status; native stays out', async () => {
  const view = await mount(backend());
  try {
    const rows = view.rows();
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map(row => row.querySelector('.setting-label').textContent), ['Claude Code', 'Codex', 'Devin']);
    assert.match(rows[0].textContent, /使用本机 Claude 登录和配置/);
    assert.match(rows[1].textContent, /未安装 · 未找到 Codex ACP 适配器/);
    const checked = rows.map(row => row.querySelector('[role="switch"]').getAttribute('aria-checked'));
    assert.deepEqual(checked, ['true', 'true', 'false']);
    assert.equal(rows[1].querySelector('button:not([role="switch"])').textContent, '安装说明');
    assert.equal(rows[0].querySelector('button:not([role="switch"])'), null);
  } finally { await view.close(); }
});

test('the visibility switch writes hiddenAgents back to preferences and notifies the workbench', async () => {
  const api = backend();
  let changed = 0;
  const view = await mount(api, { onChanged: () => changed++ });
  try {
    await act(async () => view.rows()[0].querySelector('[role="switch"]').click());
    const hide = api.calls.find(call => call.method === 'PUT');
    assert.equal(hide.path, '/agent-engines/preferences');
    assert.deepEqual(hide.body, { hiddenAgents: ['claude-code', 'devin'] });
    assert.equal(changed, 1);
    assert.equal(api.calls.filter(call => call.method === 'GET').length, 2);

    await act(async () => view.rows()[2].querySelector('[role="switch"]').click());
    const unhide = api.calls.filter(call => call.method === 'PUT').at(-1);
    assert.deepEqual(unhide.body, { hiddenAgents: [] });
    assert.equal(changed, 2);
  } finally { await view.close(); }
});

test('the unavailable row opens the provider install prompt and closes it', async () => {
  const view = await mount(backend());
  try {
    await act(async () => view.rows()[1].querySelector('button:not([role="switch"])').click());
    const dialog = view.container.querySelector('[role="dialog"]');
    assert.equal(dialog.getAttribute('aria-label'), 'Codex ACP 安装说明');
    assert.match(dialog.textContent, /当前检测：未找到 Codex ACP 适配器/);
    assert.equal(dialog.querySelector('pre').textContent, '帮我安装好 Codex 和它的 ACP 适配器，让三方应用能通过 ACP 协议驱动它');
    await act(async () => [...dialog.querySelectorAll('button')].find(button => button.textContent === '关闭').click());
    assert.equal(view.container.querySelector('[role="dialog"]'), null);
  } finally { await view.close(); }
});

test('re-detect issues a fresh engine scan', async () => {
  const api = backend();
  const view = await mount(api);
  try {
    assert.equal(api.calls.filter(call => call.method === 'GET').length, 1);
    await act(async () => [...view.container.querySelectorAll('button')].find(button => button.textContent === '重新检测').click());
    assert.equal(api.calls.filter(call => call.method === 'GET').length, 2);
  } finally { await view.close(); }
});
