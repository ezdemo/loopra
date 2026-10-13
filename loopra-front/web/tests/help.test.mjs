import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// The help center is static content plus a search index; assert the ported
// sections are reachable and that search covers commands, tools and config.
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

const iconStub = dataUrl('export default {};export const Activity=()=>null;export const HelpCircle=()=>null;export const Search=()=>null;export const X=()=>null;');
const nextuiStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const Modal = ({ children }) => createElement('div', { role: 'dialog' }, children);
export const ModalContent = ({ children }) => createElement('div', null, children);
export const Tooltip = ({ children }) => children;
export const Button = ({ children, onPress, ...rest }) => createElement('button', { type: 'button', onClick: onPress, ...rest }, children);
`);

const helpUrl = await sourceUrl('help.ts');
const { searchHelp, helpSections, helpCommands } = await import(helpUrl);
const Help = (await import(await sourceUrl('components/Help.tsx', {
  '@nextui-org/react': nextuiStub,
  './ui': dataUrl(`const { createElement } = await import(${JSON.stringify(reactUrl)});
export const IconButton = ({ label, children, onClick }) => createElement('button', { type: 'button', 'aria-label': label, onClick }, children);`),
  'lucide-react': iconStub,
  '../help': helpUrl,
}))).default;

test('the ported help sections keep the legacy table of contents', () => {
  assert.deepEqual(helpSections.map(section => section.title), ['快速入门', '命令参考', '工具列表', '配置说明', '故障排除', 'API 文档', '更新日志']);
});

test('search reaches commands, tools, endpoints and config options', () => {
  assert.deepEqual(searchHelp('compact').map(hit => hit.section.id), ['commands']);
  assert.deepEqual(searchHelp('/api/agent/prompt').map(hit => hit.section.id), ['api']);
  assert.deepEqual(searchHelp('file_path').map(hit => hit.section.id), ['tools']);
  assert.deepEqual(searchHelp('/api/usage').map(hit => hit.section.id), ['api']);
  assert.deepEqual(searchHelp('workspaceDir').map(hit => hit.section.id), ['config']);
  assert.equal(searchHelp('   ').length, 0);
  assert.equal(searchHelp('nothing-matches-this').length, 0);
});

test('the command table mirrors the commands the backend and web shell really handle', () => {
  const names = helpCommands.map(command => command.name);
  for (const name of ['/new', '/clear', '/compact', '/export', '/continue', '/sessions', '/plan', '/execute', '/goal', '/hitl', '/agree', '/deny', '/init', '/plugin', '/help']) {
    assert.ok(names.includes(name), `missing ${name}`);
  }
  for (const stale of ['/retry', '/rewind', '/load', '/exit']) assert.ok(!names.includes(stale), `${stale} is not handled anymore`);
});

test('rendering lists the sections, shortcuts and API endpoints', async () => {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Help, { open: true, onClose: () => {}, server: 'http://127.0.0.1:4567' })));
  const text = container.textContent;
  for (const title of ['帮助中心', '快速入门', '命令参考', '工具列表', '配置说明', '故障排除', 'API 文档', '更新日志']) assert.ok(text.includes(title), `missing ${title}`);
  assert.ok(container.querySelectorAll('.help-nav li button').length === 7);
  assert.ok(text.includes('Ctrl+K'), 'shortcut list is rendered');
  assert.ok(text.includes('/api/sessions/{name}'), 'endpoint list is rendered');
  assert.ok(text.includes('http://127.0.0.1:4567'), 'server address is shown');
  await act(async () => root.unmount()); container.remove();
});

test('searching replaces the sections with hit cards', async () => {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(Help, { open: true, onClose: () => {}, server: 'http://x' })));
  const input = container.querySelector('input[aria-label="搜索帮助文档"]');
  assert.ok(input);
  // React tracks input values through its own setter, so drive the native one.
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  await act(async () => { setValue.call(input, 'tool'); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
  const text = container.textContent;
  assert.ok(text.includes('搜索结果'), 'search results replace the sections');
  assert.ok(container.querySelectorAll('.help-results button').length >= 1, 'tool hits are listed');
  assert.ok(!container.querySelector('.help-section'), 'the full sections are hidden while searching');
  await act(async () => root.unmount()); container.remove();
});
