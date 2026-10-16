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

const iconsStub = dataUrl('export const RefreshCw=()=>null;');
const uiStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const IconButton = ({ label, children, onClick }) => createElement('button', { type: 'button', 'aria-label': label, onClick }, children);
`);
const controlsStub = dataUrl(`
const React = await import(${JSON.stringify(reactUrl)});
export const errorText = cause => cause instanceof Error ? cause.message : String(cause);
export function useRemote(api, path) {
  const [state, setState] = React.useState({ data: undefined, error: '', loading: !!path });
  React.useEffect(() => {
    let live = true;
    if (!path) return undefined;
    api.request(path, 'GET').then(data => { if (live) setState({ data, error: '', loading: false }); });
    return () => { live = false; };
  }, [api, path]);
  return state;
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

async function mount() {
  globalThis.__calls = []; globalThis.__notify = [];
  const api = {
    request: (path, method = 'GET', body) => {
      globalThis.__calls.push({ path, method, body });
      return Promise.resolve(payload);
    },
  };
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Panel, { api, workspaceHash: 'hash 1', workspaceName: 'loopra', notify: message => globalThis.__notify.push(message) })));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return { container, root, async close() { await act(async () => root.unmount()); container.remove(); } };
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
