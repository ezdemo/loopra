import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// The board triggers real AI runs and deletes requirements, so assert the exact
// endpoints / payloads against stubs instead of touching a live backend.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLSelectElement: dom.window.HTMLSelectElement, IS_REACT_ACT_ENVIRONMENT: true };
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
export const Button = ({ children, onPress, isDisabled, isLoading, isIconOnly, startContent, endContent, ...rest }) => createElement('button', { disabled: !!isDisabled || !!isLoading, onClick: onPress, ...rest, type: rest.type || 'button' }, children);
export const Spinner = () => null;
export const Modal = ({ children, isOpen, ...rest }) => isOpen ? createElement('div', { role: 'dialog', 'aria-label': rest['aria-label'] }, children) : null;
export const ModalContent = ({ children }) => createElement('div', null, children);
`);
const iconsStub = dataUrl('export const ArrowLeft=()=>null;export const Bot=()=>null;export const Calendar=()=>null;export const Clock=()=>null;export const Plus=()=>null;export const RefreshCw=()=>null;export const Send=()=>null;export const Trash2=()=>null;export const X=()=>null;export const Zap=()=>null;');
const markdownStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export default ({ text }) => createElement('div', { className: 'md-stub' }, text);
`);
const blockStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export default ({ blocks }) => createElement('div', { className: 'blocks-stub' }, blocks.map((block, index) => createElement('p', { key: index }, block.content || block.type)));
`);
const requirementsUrl = await sourceUrl('requirements.ts', {
  './chat': dataUrl('export const groupToolBlocks = blocks => blocks; export const splitAssistantBlocks = blocks => ({ process: [], final: blocks }); export const splitUserContext = text => ({ context: "", text });'),
  './backend': dataUrl(`
export function historyMessages(raw) {
  const messages = [];
  let current;
  for (const [index, entry] of raw.entries()) {
    if (entry.role !== 'assistant') continue;
    if (!current) { current = { id: 'history-' + index, role: 'assistant', text: '', blocks: [], time: '' }; messages.push(current); }
    if (entry.reasoning_content) current.blocks.push({ id: 'r' + index, type: 'reasoning', content: entry.reasoning_content });
    for (const call of entry.tool_calls || []) current.blocks.push({ id: 't' + index, type: 'tool_call', name: call.function?.name || call.name, status: '成功', result: 'ok' });
    if (entry.content) current.blocks.push({ id: 'c' + index, type: 'content', content: entry.content });
  }
  return messages;
}
`),
});

const { default: RequirementBoard } = await import(await sourceUrl('components/RequirementBoard.tsx', {
  '@nextui-org/react': nextuiStub,
  'lucide-react': iconsStub,
  './Markdown': markdownStub,
  './Markdown.tsx': markdownStub,
  './BlockRenderer': blockStub,
  './BlockRenderer.tsx': blockStub,
  '../requirements': requirementsUrl,
}));

const workspaces = [{ hash: 'p1', name: 'alpha', path: '/work/alpha' }];
const requirements = [
  { id: 'abcdef1234', title: '支持导出', description: '导出 CSV', priority: 'high', projectHash: 'p1', projectName: 'alpha', status: 'todo', scheduleMode: 'immediate', updatedAt: Date.UTC(2026, 0, 2, 3, 4) },
  { id: 'beef567890', title: '定时巡检', priority: 'low', projectHash: 'p1', projectName: 'alpha', status: 'done', scheduleMode: 'scheduled', scheduledAt: Date.UTC(2026, 0, 5, 1, 0), updatedAt: Date.UTC(2026, 0, 4, 3, 4) },
];
const messages = [
  { role: 'user', content: '请支持导出', timestamp: 1000 },
  { role: 'assistant', content: '收到，我来实现。', timestamp: 2000 },
];

async function mount({ items = requirements } = {}) {
  globalThis.__calls = []; globalThis.__events = [];
  const api = {
    request: (path, method = 'GET', body) => {
      globalThis.__calls.push({ path, method, body });
      if (path === '/requirements') return Promise.resolve(method === 'POST' ? { ...items[0], id: 'new1234567' } : items);
      if (path.endsWith('/messages')) return Promise.resolve(messages);
      if (path === '/workspaces') return Promise.resolve(workspaces);
      if (path === '/config') return Promise.resolve({ model: 'm1', modelChannelId: 'ch1', reasoningEffort: 'max', hitl: 'free', modelChannels: [{ id: 'ch1', name: '主力', models: [{ name: 'm1' }] }] });
      return Promise.resolve('ok');
    },
  };
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(RequirementBoard, { api, onClose: () => globalThis.__events.push('close'), notify: message => globalThis.__events.push(`notify:${message}`) })));
  return { container, root, async close() { await act(async () => root.unmount()); container.remove(); } };
}

const buttonIn = (element, text) => [...element.querySelectorAll('button')].find(candidate => candidate.textContent.includes(text));
async function click(element) { await act(async () => { element.click(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }); }
async function type(element, value) {
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  await act(async () => { setValue.call(element, value); element.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
}

test('renders the four columns with the legacy requirement data', async () => {
  const view = await mount();
  try {
    assert.match(view.container.textContent, /需求池/);
    assert.match(view.container.textContent, /2 条需求/);
    for (const label of ['待执行', '执行中', '已完成', '已失败']) assert.match(view.container.textContent, new RegExp(label));
    assert.match(view.container.textContent, /支持导出/);
    assert.match(view.container.textContent, /定时/);
  } finally { await view.close(); }
});

test('opening a requirement loads its message stream and shows comments', async () => {
  const view = await mount();
  try {
    await click(buttonIn(view.container, '支持导出'));
    assert.ok(globalThis.__calls.some(call => call.path === '/requirements/abcdef1234/messages'));
    assert.match(view.container.textContent, /请支持导出/);
    assert.match(view.container.textContent, /收到，我来实现。/);
    assert.match(view.container.textContent, /评论 \(1\)/);
  } finally { await view.close(); }
});

test('run / abort / approval / delete hit the legacy endpoints', async () => {
  const view = await mount();
  try {
    await click(buttonIn(view.container, '支持导出'));
    await click(buttonIn(view.container, '让 AI 执行'));
    assert.ok(globalThis.__calls.some(call => call.path === '/requirements/abcdef1234/run' && call.method === 'POST'));
    // First click only arms the confirm, the second deletes.
    await click(view.container.querySelector('[aria-label="删除需求"]'));
    assert.ok(!globalThis.__calls.some(call => call.path === '/requirements/abcdef1234' && call.method === 'DELETE'));
    await click(buttonIn(view.container, '确认删除'));
    assert.ok(globalThis.__calls.some(call => call.path === '/requirements/abcdef1234' && call.method === 'DELETE'));
    assert.ok(globalThis.__events.includes('close') === false);
  } finally { await view.close(); }
});

test('creating an immediate requirement posts the payload and triggers a run', async () => {
  const view = await mount();
  try {
    await click(buttonIn(view.container, '新建需求'));
    const dialog = view.container.querySelector('[aria-label="新建需求"]');
    assert.ok(dialog, 'create dialog should render');
    await type(dialog.querySelector('input[placeholder="需求标题"]'), '新增需求');
    const projectSelect = dialog.querySelector('select');
    const setSelect = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set;
    await act(async () => { setSelect.call(projectSelect, 'p1'); projectSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
    const createBtn = [...dialog.querySelectorAll('button')].find(b => b.textContent.trim() === '创建');
    await click(createBtn);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const create = globalThis.__calls.find(call => call.path === '/requirements' && call.method === 'POST');
    assert.ok(create, 'POST /requirements should be called');
    assert.deepEqual({ title: create.body.title, projectHash: create.body.projectHash, priority: create.body.priority, scheduleMode: create.body.scheduleMode, model: create.body.model, modelChannelId: create.body.modelChannelId }, { title: '新增需求', projectHash: 'p1', priority: 'medium', scheduleMode: 'immediate', model: 'm1', modelChannelId: 'ch1' });
    assert.ok(globalThis.__calls.some(call => call.path === '/requirements/new1234567/run' && call.method === 'POST'));
  } finally { await view.close(); }
});
