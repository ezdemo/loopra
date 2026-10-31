import { fieldStubs, checkboxStub } from './helpers/form-controls.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// The tool manager toggles server-side tool state, so assert the exact endpoints,
// the read-only tri-state body and the overview/filter counts against stubs.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
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
const nextuiStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const Button = ({ children, onPress, isDisabled, isLoading, className, startContent, endContent, isIconOnly, variant, size, color, ...rest }) => createElement('button', { type: 'button', disabled: !!isDisabled || !!isLoading, onClick: onPress, className: className || undefined, ...rest }, children);
${checkboxStub}
`);
const controlsStub = dataUrl(`
const React = await import(${JSON.stringify(reactUrl)});
export const errorText = cause => cause instanceof Error ? cause.message : String(cause);
export const query = values => new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])).toString();
export function useRemote(api, path, revision = 0) {
  const [state, setState] = React.useState({ data: undefined, error: '', loading: !!path });
  React.useEffect(() => { let live = true; setState({ data: undefined, error: '', loading: !!path }); if (!path) return undefined;
    api.request(path, 'GET').then(data => { if (live) setState({ data, error: '', loading: false }); }).catch(error => { if (live) setState({ data: undefined, error: errorText(error), loading: false }); });
    return () => { live = false; }; }, [api, path, revision]);
  return state;
}
export const RemoteState = ({ loading, error }) => error ? React.createElement('p', { role: 'alert' }, error) : null;
export function ConfirmAction() { return null; }
`);
const settingControlsStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const PageHeader = ({ title, children }) => createElement('header', null, title, children);
${fieldStubs}
`);
const usageStub = dataUrl('export const UsageDashboard = () => null;');
const gitModelsSource = await readFile(new URL('../src/git-models.ts', import.meta.url), 'utf8');
const { outputText: gitModelsOut } = ts.transpileModule(gitModelsSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const gitModelsUrl = dataUrl(gitModelsOut);
const subAgentsUrl = await sourceUrl('components/SubAgentManager.tsx', {
  '@nextui-org/react': nextuiStub,
  'lucide-react': import.meta.resolve('lucide-react'),
  './RemoteControls': controlsStub,
  './SettingControls': settingControlsStub,
  '../git-models': gitModelsUrl,
  '../composer': await sourceUrl('composer.ts'),
});
const { ToolManager, SubAgentManager } = await import(await sourceUrl('components/ResourceManagers.tsx', {
  '@nextui-org/react': nextuiStub,
  'lucide-react': import.meta.resolve('lucide-react'),
  './PluginFrame': dataUrl('export const PluginFrame = () => null;'),
  './PluginCatalog': dataUrl('export const PluginCatalog = () => null;'),
  './plugin-icons': dataUrl('export const PluginGlyph = () => null; export const pluginTone = () => "#4f6ef7";'),
  './RemoteControls': controlsStub,
  './SettingControls': settingControlsStub,
  './UsageDashboard': usageStub,
  '../git-models': gitModelsUrl,
  './SubAgentManager': subAgentsUrl,
}));

const tools = [
  { name: 'read_file', description: '读取文件', readOnly: true, readOnlyOverride: null, stormExempt: true, enabled: true, autoApproved: false, params: [{ name: 'path', type: 'string', description: '文件路径' }] },
  { name: 'write_file', description: '写入文件', readOnly: false, readOnlyOverride: true, stormExempt: false, enabled: true, autoApproved: true },
  { name: 'legacy_tool', description: '旧工具', readOnly: false, readOnlyOverride: null, stormExempt: false, enabled: false, autoApproved: false },
];

async function mount() {
  globalThis.__calls = [];
  const api = { request: (path, method = 'GET', body) => { globalThis.__calls.push({ path, method, body }); return Promise.resolve(tools); } };
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(ToolManager, { api, onRefresh: async () => {} })));
  return { container, root, async close() { await act(async () => root.unmount()); container.remove(); } };
}
const buttonIn = (element, text) => [...element.querySelectorAll('button')].find(candidate => candidate.textContent.trim() === text);
async function click(element) { await act(async () => { element.click(); await Promise.resolve(); await Promise.resolve(); }); }

test('summarises and filters the tool list', async () => {
  const view = await mount();
  try {
    const stats = [...view.container.querySelectorAll('.tools-stat')].map(node => node.textContent);
    assert.deepEqual(stats, ['工具总数3', '只读1', '写入2', '风暴豁免1', '已停用1']);
    // 切到「已停用」只剩 legacy_tool
    await click(buttonIn(view.container.querySelector('.tools-filters'), '已停用1'));
    const cards = [...view.container.querySelectorAll('.workbench-card')].map(node => node.querySelector('strong').textContent);
    assert.deepEqual(cards, ['legacy_tool']);
  } finally { await view.close(); }
});

test('the read-only tri-state posts null/true/false', async () => {
  const view = await mount();
  try {
    // 每次操作后列表会重新拉取，卡片会被重建，因此每次都重新查询。
    const card = () => [...view.container.querySelectorAll('.workbench-card')].find(node => node.querySelector('strong').textContent === 'write_file');
    await click(buttonIn(card().querySelector('.tools-readonly-modes'), '默认'));
    await click(buttonIn(card().querySelector('.tools-readonly-modes'), '只读'));
    await click(buttonIn(card().querySelector('.tools-readonly-modes'), '写入'));
    const posts = globalThis.__calls.filter(call => call.path === '/tools/write_file/read-only');
    assert.deepEqual(posts.map(call => call.body), [{ readOnly: null }, { readOnly: true }, { readOnly: false }]);
  } finally { await view.close(); }
});

test('enable and auto-approve toggles hit their endpoints', async () => {
  const view = await mount();
  try {
    const card = () => [...view.container.querySelectorAll('.workbench-card')].find(node => node.querySelector('strong').textContent === 'legacy_tool');
    await click(buttonIn(card(), '启用'));
    await click(buttonIn(card(), '自动放行'));
    assert.ok(globalThis.__calls.some(call => call.path === '/tools/legacy_tool/toggle' && call.method === 'POST'));
    assert.ok(globalThis.__calls.some(call => call.path === '/tools/legacy_tool/auto-toggle' && call.method === 'POST'));
  } finally { await view.close(); }
});

// Legacy SubAgents.vue offered one-click "import all read-only / all write" while
// editing a role's tool whitelist, excluding sub-agent-denied and disabled tools.
const profileTools = [
  { name: 'read_file', readOnly: true, enabled: true },
  { name: 'write_file', readOnly: false, enabled: true },
  { name: 'denied_tool', readOnly: true, enabled: true },
  { name: 'disabled_tool', readOnly: false, enabled: false },
];

async function mountSubAgents(initialProfiles = []) {
  globalThis.__calls = [];
  let profiles = initialProfiles;
  const api = { request: (path, method = 'GET', body) => {
    globalThis.__calls.push({ path, method, body });
    if (path === '/sub-agents' && method === 'PUT') profiles = body.profiles.map(profile => ({ ...profile, systemPrompt: profile.instructions }));
    const data = path.startsWith('/sub-agents/denied-tools') ? ['denied_tool']
      : path.startsWith('/sub-agents') ? profiles
      : path.startsWith('/models') ? { models: [{ name: 'gpt-6-sol', displayName: 'GPT-6 Sol', channelId: 'kimi', channelName: 'Kimi Code · DeepSeek' }, { name: 'claude', channelId: 'cpa', channelName: 'CPA' }] }
      : path.startsWith('/tools') ? profileTools : undefined;
    return Promise.resolve(data);
  } };
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(SubAgentManager, { api })));
  return { container, root, async close() { await act(async () => root.unmount()); container.remove(); } };
}
const labelWithText = (scope, text) => [...scope.querySelectorAll('label')].find(node => node.textContent.trim() === text);
const checkedToolNames = (scope) => [...scope.querySelectorAll('label.workbench-actions input[type=checkbox]')]
  .map(input => [input.parentElement.textContent.trim(), input.checked])
  .filter(([name]) => profileTools.some(tool => tool.name === name))
  .filter(([, checked]) => checked)
  .map(([name]) => name);

// Legacy SubAgents.vue chose a role's model from channel then model dropdowns and
// omitted both fields when the role inherits the main agent.
test('the sub-agent editor picks channel/model from dropdowns and inherits by default', async () => {
  const view = await mountSubAgents();
  try {
    await click(buttonIn(view.container, '新增角色'));
    const form = () => view.container.querySelector('form');
    const channelSelect = () => form().querySelector('select[aria-label="模型渠道"]');
    assert.ok(channelSelect(), 'channel dropdown renders');
    assert.deepEqual([...channelSelect().options].map(option => [option.value, option.textContent]), [['', '继承主代理（默认）'], ['kimi', 'Kimi Code · DeepSeek'], ['cpa', 'CPA']]);
    // 继承主代理时没有渠道模型下拉。
    assert.equal(form().querySelector('select[aria-label="渠道模型"]'), null);
    channelSelect().value = 'kimi';
    await act(async () => { channelSelect().dispatchEvent(new dom.window.Event('change', { bubbles: true })); await Promise.resolve(); });
    const modelSelect = () => form().querySelector('select[aria-label="渠道模型"]');
    assert.deepEqual([...modelSelect().options].map(option => [option.value, option.textContent]), [['', '渠道默认模型'], ['gpt-6-sol', 'GPT-6 Sol']]);
    // 切换渠道会重置已选模型。
    channelSelect().value = '';
    await act(async () => { channelSelect().dispatchEvent(new dom.window.Event('change', { bubbles: true })); await Promise.resolve(); });
    assert.equal(form().querySelector('select[aria-label="渠道模型"]'), null);
    // 提交时继承主代理的角色不写 model/modelChannel。
    await act(async () => { form().dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); await Promise.resolve(); await Promise.resolve(); });
    const put = globalThis.__calls.find(call => call.path === '/sub-agents' && call.method === 'PUT');
    assert.ok(put, 'save posts the profile list');
    const saved = put.body.profiles.at(-1);
    assert.equal(saved.modelChannel, undefined);
    assert.equal(saved.model, undefined);
  } finally { await view.close(); }
});

test('the sub-agent tool whitelist imports all read-only or all write tools', async () => {
  const view = await mountSubAgents();
  try {
    await click(buttonIn(view.container, '新增角色'));
    const form = () => view.container.querySelector('form');
    // 默认继承工具时没有导入按钮。
    assert.ok(!buttonIn(form(), '一键导入只读'));
    // 关掉只读角色，让只读与写入工具都出现在复选列表中。
    await click(labelWithText(form(), '只读角色').querySelector('input'));
    // 取消「继承可用工具」后开始显式配置白名单。
    await click(labelWithText(form(), '继承可用工具').querySelector('input'));
    await click(buttonIn(form(), '一键导入只读'));
    assert.deepEqual(checkedToolNames(form()), ['read_file']);
    await click(buttonIn(form(), '一键导入写入'));
    assert.deepEqual(checkedToolNames(form()), ['write_file']);
  } finally { await view.close(); }
});

test('compact role browsing and editing preserve prompts, tool permissions and raw model IDs', async () => {
  const source = { id: 'review', name: '代码审查', description: '检查代码质量与潜在问题', readOnly: true, enable: true, systemPrompt: 'Review with evidence and do not modify files.', allowedTools: ['read_file'], tools: ['read_file'], modelChannel: 'kimi', model: 'gpt-6-sol' };
  const view = await mountSubAgents([source]);
  try {
    const row = () => view.container.querySelector('.agent-role-row');
    assert.ok(row().textContent.includes('GPT-6 Sol'));
    assert.equal(row().querySelector('pre'), null, 'the prompt is disclosed on demand');
    await click(row().querySelector('.agent-role-detail-toggle'));
    assert.equal(row().querySelector('pre').textContent, source.systemPrompt);
    assert.ok(row().querySelector('.agent-role-tool-chips').textContent.includes('read_file'));
    await click(row().querySelector('button[aria-label="编辑 代码审查"]'));
    const form = view.container.querySelector('form');
    assert.equal(form.querySelector('input[aria-label="角色 ID"]').readOnly, true);
    assert.equal(form.querySelector('textarea[aria-label="角色提示词"]').value, source.systemPrompt);
    assert.equal(form.querySelector('select[aria-label="渠道模型"]').value, source.model);
    await click(buttonIn(form, '取消'));
    assert.equal(globalThis.__calls.filter(call => call.method === 'PUT').length, 0);
    await click(row().querySelector('button[aria-label="停用 代码审查"]'));
    const saved = globalThis.__calls.find(call => call.method === 'PUT').body.profiles[0];
    assert.equal(saved.enable, false);
    assert.equal(saved.instructions, source.systemPrompt);
    assert.equal(saved.readOnly, true);
    assert.deepEqual(saved.allowedTools, source.allowedTools);
    assert.equal(saved.model, source.model);
    assert.equal(saved.modelChannel, source.modelChannel);
    const input = view.container.querySelector('input[aria-label="搜索角色"]');
    await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, '不存在'); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    assert.equal(row(), null);
    assert.ok(view.container.textContent.includes('没有匹配的角色'));
    await click(buttonIn(view.container, '清除搜索'));
    assert.ok(row());
  } finally { await view.close(); }
});
