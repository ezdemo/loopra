import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// Project capabilities come straight from `.loopra`; assert the read path, the
// summary maths and the refresh POST against stubs instead of a live backend.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });

const { act, createElement } = await import('react');
const { Simulate } = await import('react-dom/test-utils');
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

const iconsStub = dataUrl('export const AlertCircle=()=>null, BookOpen=()=>null, ChevronRight=()=>null, Folder=()=>null, Plug=()=>null, Puzzle=()=>null, RefreshCw=()=>null, Search=()=>null, Wrench=()=>null, X=()=>null;');
const uiStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const IconButton = ({ label, children, onClick }) => createElement('button', { type: 'button', 'aria-label': label, onClick }, children);
`);
const controlsStub = dataUrl(`
const React = await import(${JSON.stringify(reactUrl)});
export const errorText = cause => cause instanceof Error ? cause.message : String(cause);
export function useRemote(api, path, revision) {
  const [state, setState] = React.useState({ data: undefined, error: '', loading: !!path });
  React.useEffect(() => {
    let live = true;
    if (!path) return undefined;
    setState({ data: undefined, error: '', loading: true });
    api.request(path, 'GET').then(data => { if (live) setState({ data, error: '', loading: false }); })
      .catch(error => { if (live) setState({ data: undefined, error: error.message, loading: false }); });
    return () => { live = false; };
  }, [api, path, revision]);
  return { ...state, setData: data => setState(current => ({ ...current, data })) };
}
export const RemoteState = ({ loading, error }) => error ? React.createElement('p', { role: 'alert' }, error) : null;
`);
const capabilitiesUrl = await sourceUrl('capabilities.ts');
const Panel = (await import(await sourceUrl('components/ProjectCapabilities.tsx', {
  'lucide-react': iconsStub, './ui': uiStub, './RemoteControls': controlsStub, '../capabilities': capabilitiesUrl,
}))).default;

const payload = {
  workspacePath: 'C:/code/loopra', mcpConfigPath: 'C:/code/loopra/.loopra/mcp-servers.json', mcpConfigExists: true,
  projectSkillsPath: 'C:/code/loopra/.loopra/skills', projectSkillsDirectoryExists: true,
  skills: [
    { name: 'project-helper', description: '项目内技能', scope: 'project', mountAlias: 'proj', path: 'C:/code/loopra/.loopra/skills/project-helper' },
    { name: 'global-helper', description: '全局技能', scope: 'global' },
  ],
  mcpServers: [
    { name: 'filesystem', type: 'stdio', enabled: true, loaded: true, toolCount: 2, toolNames: ['read_file', 'write_file'] },
    { name: 'broken', type: 'sse', enabled: false, loaded: false, toolCount: 0, error: 'boom' },
  ],
};

async function mount(request) {
  globalThis.__calls = []; globalThis.__notify = [];
  const api = {
    request: (path, method = 'GET', body) => {
      globalThis.__calls.push({ path, method, body });
      return request ? request(path, method, body) : Promise.resolve(payload);
    },
  };
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Panel, { api, workspaceHash: 'hash 1', workspaceName: 'loopra', notify: message => globalThis.__notify.push(message) })));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return { container, root,
    async revision(value) { await act(async () => root.render(createElement(Panel, { api, workspaceHash: 'hash 1', workspaceName: 'loopra', revision: value, notify: () => {} }))); },
    async close() { await act(async () => root.unmount()); container.remove(); } };
}

test('renders only project-scoped skills plus the MCP summary', async () => {
  const view = await mount();
  try {
    assert.deepEqual(globalThis.__calls[0], { path: '/agent/project-capabilities?workspaceHash=hash%201', method: 'GET', body: undefined });
    const text = view.container.textContent;
    assert.match(text, /project-helper/);
    assert.doesNotMatch(text, /global-helper/);
    assert.match(text, /filesystem/);
    assert.match(text, /已禁用/);
    assert.match(text, /2 个工具/);
    assert.match(text, /read_file/);
  } finally { await view.close(); }
});

test('refresh posts to the reload endpoint and reports back', async () => {
  const view = await mount();
  try {
    await act(async () => { view.container.querySelector('button[aria-label="刷新项目能力"]').click(); await Promise.resolve(); });
    assert.deepEqual(globalThis.__calls.at(-1), { path: '/agent/project-capabilities/refresh?workspaceHash=hash%201', method: 'POST', body: undefined });
    assert.deepEqual(globalThis.__notify, ['项目能力已刷新']);
  } finally { await view.close(); }
});

test('without a workspace the panel asks for one instead of fetching', async () => {
  globalThis.__calls = [];
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Panel, { api: { request: (path, method) => { globalThis.__calls.push({ path, method }); return Promise.resolve(payload); } }, workspaceHash: '', notify: () => {} })));
  assert.match(container.textContent, /请先选择项目/);
  assert.deepEqual(globalThis.__calls, []);
  await act(async () => root.unmount()); container.remove();
});

test('skill and MCP empty states distinguish a missing file from an empty list', async () => {
  const module = await import(capabilitiesUrl);
  assert.equal(module.projectSkillEmptyText({ projectSkillsDirectoryExists: true }), '目录中暂无 SKILL.md');
  assert.equal(module.projectSkillEmptyText({}), '未找到 .loopra/skills/');
  assert.equal(module.mcpEmptyText({ mcpConfigExists: true }), '配置文件存在，但没有可用服务器');
  assert.equal(module.mcpEmptyText({}), '未找到 .loopra/mcp-servers.json');
  assert.equal(module.mcpToolCount([{ toolCount: 3 }, { toolCount: 4 }, {}]), 7);
  assert.equal(module.mcpTypeLabel('streamable'), 'Streamable HTTP');
  assert.equal(module.mcpStatusLabel({ enabled: false, loaded: true }), '已禁用');
  assert.equal(module.mcpStatusLabel({ enabled: true, loaded: false, error: 'boom' }), '加载失败');
  assert.equal(module.mcpStatusLabel({ enabled: true, loaded: false }), '未加载');
});

test('category filters show only the selected type and restore the overview', async () => {
  const view = await mount();
  try {
    const filters = [...view.container.querySelectorAll('.capabilities-filters button')];
    await act(async () => filters[1].click());
    assert.equal(filters[1].getAttribute('aria-pressed'), 'true');
    assert.ok(view.container.querySelector('[aria-label="项目 Skill"]'));
    assert.equal(view.container.querySelector('[aria-label="项目 MCP"]'), null);
    await act(async () => filters[2].click());
    assert.equal(view.container.querySelector('[aria-label="项目 Skill"]'), null);
    assert.ok(view.container.querySelector('[aria-label="项目 MCP"]'));
    await act(async () => filters[0].click());
    assert.ok(view.container.querySelector('[aria-label="项目 Skill"]'));
    assert.ok(view.container.querySelector('[aria-label="项目 MCP"]'));
  } finally { await view.close(); }
});

test('search finds a server through its tools, then clearing it restores all entries', async () => {
  const view = await mount();
  try {
    const input = view.container.querySelector('input[type="search"]');
    await act(async () => Simulate.change(input, { target: { value: 'WRITE_FILE' } }));
    assert.match(view.container.textContent, /filesystem/);
    assert.doesNotMatch(view.container.textContent, /project-helper/);
    assert.doesNotMatch(view.container.textContent, /broken/);
    await act(async () => Simulate.change(input, { target: { value: 'does-not-exist' } }));
    assert.match(view.container.textContent, /没有匹配的能力/);
    await act(async () => view.container.querySelector('[aria-label="清空能力搜索"]').click());
    assert.match(view.container.textContent, /project-helper/);
    assert.match(view.container.textContent, /broken/);
  } finally { await view.close(); }
});

test('skill details contain the full description and source path, MCP has individual tool rows', async () => {
  const view = await mount();
  try {
    const skill = view.container.querySelector('.skill-entry');
    await act(async () => skill.querySelector('summary').click());
    assert.equal(skill.open, true);
    assert.equal(skill.querySelector('.capability-description').textContent, '项目内技能');
    assert.match(skill.querySelector('.capability-source').textContent, /C:\/code\/loopra\/\.loopra\/skills\/project-helper/);
    assert.equal(view.container.querySelector('.mcp-status.connected').textContent, '已连接');
    assert.equal(view.container.querySelector('.mcp-status.disabled').textContent, '已禁用');
    assert.deepEqual([...view.container.querySelectorAll('.mcp-tools code')].map(item => item.textContent), ['read_file', 'write_file']);
  } finally { await view.close(); }
});

test('refresh retains visible entries while pending and replaces them with the POST result', async () => {
  let finish;
  const view = await mount((_path, method) => method === 'POST'
    ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(payload));
  try {
    const button = view.container.querySelector('[aria-label="刷新项目能力"]');
    await act(async () => button.click());
    assert.equal(button.disabled, true);
    assert.match(view.container.textContent, /project-helper/);
    await act(async () => button.click());
    assert.equal(globalThis.__calls.filter(call => call.method === 'POST').length, 1);
    await act(async () => finish({ ...payload, skills: [], mcpServers: [] }));
    assert.equal(button.disabled, false);
    assert.match(view.container.textContent, /还没有项目 Skill/);
    assert.doesNotMatch(view.container.textContent, /project-helper/);
    assert.equal(globalThis.__calls.filter(call => call.method === 'GET').length, 1);
  } finally { await view.close(); }
});

test('a failed refresh keeps the prior results and exposes a working inline retry', async () => {
  let failed = true;
  const view = await mount((_path, method) => method === 'POST' && failed ? Promise.reject(new Error('项目任务正在运行')) : Promise.resolve(payload));
  try {
    await act(async () => view.container.querySelector('[aria-label="刷新项目能力"]').click());
    assert.match(view.container.querySelector('[role="alert"]').textContent, /刷新失败.*项目任务正在运行/);
    assert.match(view.container.textContent, /project-helper/);
    failed = false;
    await act(async () => view.container.querySelector('[role="alert"] button').click());
    assert.equal(view.container.querySelector('[role="alert"]'), null);
    assert.deepEqual(globalThis.__notify, ['项目能力已刷新']);
  } finally { await view.close(); }
});

test('initial load errors can be recovered through the refresh endpoint', async () => {
  const view = await mount((_path, method) => method === 'GET' ? Promise.reject(new Error('connection refused')) : Promise.resolve(payload));
  try {
    assert.match(view.container.querySelector('[role="alert"]').textContent, /暂时无法读取项目能力/);
    await act(async () => view.container.querySelector('[role="alert"] button').click());
    assert.equal(view.container.querySelector('[role="alert"]'), null);
    assert.match(view.container.textContent, /project-helper/);
  } finally { await view.close(); }
});

test('the workbench toolbar revision reloads the capability summary', async () => {
  const view = await mount();
  try {
    await view.revision(1);
    assert.equal(globalThis.__calls.filter(call => call.method === 'GET').length, 2);
  } finally { await view.close(); }
});

test('search is case-insensitive, includes skill descriptions, and never leaks global skills', async () => {
  const { filterProjectCapabilities } = await import(capabilitiesUrl);
  assert.deepEqual(filterProjectCapabilities(payload, ' 项目内 ').skills.map(skill => skill.name), ['project-helper']);
  assert.deepEqual(filterProjectCapabilities(payload, 'WRITE_FILE').servers.map(server => server.name), ['filesystem']);
  assert.deepEqual(filterProjectCapabilities(payload, 'global-helper').skills, []);
  assert.deepEqual(filterProjectCapabilities(undefined, 'anything'), { skills: [], servers: [] });
});
