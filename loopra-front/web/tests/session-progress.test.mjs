import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

// The Goal / checklist cards poll two read-only endpoints; mount the real
// component against stubbed responses instead of a live backend.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true, url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, IS_REACT_ACT_ENVIRONMENT: true };
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
export const Button = ({ children, onPress, isDisabled, isLoading, ...rest }) => createElement('button', { type: 'button', disabled: !!isDisabled || !!isLoading, onClick: onPress, ...rest }, children);
export const Modal = ({ children }) => createElement('div', { role: 'dialog' }, children);
export const ModalContent = ({ children }) => createElement('div', null, children);
export const ModalHeader = ({ children }) => createElement('header', null, children);
export const ModalBody = ({ children }) => createElement('div', null, children);
export const ModalFooter = ({ children }) => createElement('footer', null, children);
`);
const promptStub = dataUrl(`export const promptText = value => typeof value === 'string' ? value : (value && value.content) || '';`);
const markdownStub = dataUrl(`
const { createElement } = await import(${JSON.stringify(reactUrl)});
export const copyText = async () => true;
const Markdown = ({ text }) => createElement('div', { className: 'markdown' }, text || '');
export default Markdown;
`);
const backendStub = dataUrl('export const sessionQuery = session => `workspaceHash=${encodeURIComponent(session.workspaceHash || "")}&sessionName=${encodeURIComponent(session.name || "")}`;');
const recordDependencies = {
  '../layout/menu-placement': await sourceUrl('layout/menu-placement.ts'),
  'lucide-react': dataUrl('export const Check=()=>null, ChevronDown=()=>null, CircleAlert=()=>null, Copy=()=>null, Download=()=>null, FileText=()=>null, ListChecks=()=>null, ListTree=()=>null, LoaderCircle=()=>null, Minus=()=>null, RefreshCw=()=>null, Square=()=>null, X=()=>null;'),
  './ui': dataUrl(`const {createElement}=await import(${JSON.stringify(reactUrl)}); export const IconButton=({label,onClick,children})=>createElement('button',{'aria-label':label,className:'icon-button',type:'button',onClick},children);`),
  './RawSessionRecords': dataUrl('export default () => null;'),
};
const controlsStub = dataUrl(`
const React = await import(${JSON.stringify(reactUrl)});
export const query = values => new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])).toString();
export const RemoteState = () => null;
export const ConfirmAction = () => null;
export function useRemote(api, path, revision = 0) {
  const [state, setState] = React.useState({ data: undefined, error: '', loading: !!path });
  React.useEffect(() => {
    let live = true;
    setState({ data: undefined, error: '', loading: !!path });
    if (!path) return undefined;
    api.request(path, 'GET').then(data => { if (live) setState({ data, error: '', loading: false }); })
      .catch(error => { if (live) setState({ data: undefined, error: String(error), loading: false }); });
    return () => { live = false; };
  }, [api, path, revision]);
  return state;
}
`);

const { SessionProgress } = await import(await sourceUrl('components/SessionDetails.tsx', {
  ...recordDependencies,
  '@nextui-org/react': nextuiStub,
  '../backend': backendStub,
  './RemoteControls': controlsStub,

  '../session-prompt': promptStub,
  './Markdown': markdownStub,
}));

const goal = {
  title: '迁移剩余功能', status: 'BLOCKED', progress: '2/4',
  totalSteps: 4, doneSteps: 2, blockedReason: '等待后端接口',
  verifyCommand: 'node --test web/tests/*.test.mjs',
  steps: [
    { index: 1, description: '盘点差异', status: 'DONE', evidence: 'handoff.md' },
    { index: 2, description: '补 Goal 浮层', status: 'IN_PROGRESS' },
    { index: 3, description: '补会话清理', status: 'BLOCKED', evidence: '接口缺失' },
  ],
};
const checklist = {
  title: '发布检查', status: 'ACTIVE', currentStepIndex: 2, totalSteps: 3,
  steps: [
    { id: 'a', description: '跑单测', status: 'DONE', kind: 'FORK', result: '203 项通过' },
    { id: 'b', description: '人工确认', status: 'IN_PROGRESS', kind: 'HITL' },
    { id: 'c', description: '构建产物', status: 'PENDING' },
  ],
};

async function mount({ responses = { goal, checklist }, session = { id: 'aaa/one', title: 'one', name: 'one', workspaceHash: 'aaa' }, externalPlan, requestImpl } = {}) {
  globalThis.__calls = [];
  const api = {
    request: (path, method = 'GET') => {
      globalThis.__calls.push({ path, method });
      if (requestImpl) return requestImpl(path);
      if (path.includes('/goal?')) return Promise.resolve(responses.goal);
      if (path.includes('/checklist?')) return Promise.resolve(responses.checklist);
      if (path.includes('/acp-state?')) return Promise.resolve(responses.acp);
      return Promise.resolve(null);
    },
  };
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(SessionProgress, { api, session, revision: 0, externalPlan })));
  return { container, root, async close() { await act(async () => root.unmount()); container.remove(); } };
}

test('polls both endpoints for the active session', async () => {
  const view = await mount();
  try {
    assert.deepEqual(globalThis.__calls, [
      { path: '/sessions/one/goal?workspaceHash=aaa', method: 'GET' },
      { path: '/sessions/one/checklist?workspaceHash=aaa', method: 'GET' },
    ]);
  } finally { await view.close(); }
});

test('external plans render reported progress, restore saved state and accept empty replacements', async () => {
  const plan = [{ content: '读取项目', status: 'completed' }, { content: '修复问题', status: 'in_progress' }];
  for (const externalPlan of [undefined, [], [{ content: '新计划', status: 'pending' }]]) {
    const view = await mount({ session: { id: 'aaa/one', name: 'one', workspaceHash: 'aaa', agentId: 'codex' }, responses: { acp: { plan, commands: [] } }, externalPlan });
    try {
      assert.equal(globalThis.__calls.length, 1, 'External sessions must not query Native Goal/checklist endpoints');
      assert.match(globalThis.__calls[0].path, /\/agent\/acp-state\?/);
      if (externalPlan?.length === 0) assert.equal(view.container.querySelector('.session-progress'), null);
      else assert.match(view.container.textContent, externalPlan ? /新计划/ : /1\/2/);
    } finally { await view.close(); }
  }
});

test('renders the goal card with status, progress, blocked reason and steps', async () => {
  const view = await mount();
  try {
    const card = view.container.querySelector('.session-progress-card.is-goal');
    assert.ok(card, 'goal card renders');
    assert.equal(card.querySelector('.progress-panel-title').textContent, '迁移剩余功能');
    assert.equal(card.querySelector('.progress-state').textContent, '阻塞');
    assert.equal(card.querySelector('.progress-count').textContent, '2/4');
    assert.equal(card.querySelector('.progress-blocked').textContent, '等待后端接口');
    assert.match(card.querySelector('.progress-verify').textContent, /验证命令: node --test/);
    const steps = [...card.querySelectorAll('.progress-step')];
    assert.equal(steps.length, 3);
    assert.equal(steps[0].querySelector('small').textContent, 'handoff.md');
    assert.equal(steps[2].querySelector('small').textContent, '接口缺失');
    assert.ok(steps[1].classList.contains('in_progress'));
  } finally { await view.close(); }
});

test('renders completed counts and accessible step states while preserving HITL/FORK and results', async () => {
  const view = await mount();
  try {
    const card = view.container.querySelector('.session-progress-card.is-checklist');
    assert.ok(card, 'checklist card renders');
    assert.equal(card.querySelector('.progress-panel-title').textContent, '发布检查');
    assert.equal(card.querySelector('.progress-count').textContent, '1/3');
    assert.equal(card.querySelector('.progress-count').getAttribute('aria-label'), '已完成 1/3 项');
    const steps = [...card.querySelectorAll('.progress-step')];
    assert.equal(steps.length, 3);
    assert.equal(steps[0].querySelector('em').textContent, '分支');
    assert.equal(steps[1].querySelector('em').textContent, '人工审批');
    assert.ok(steps[1].classList.contains('current'));
    assert.equal(steps[1].getAttribute('aria-current'), 'step');
    assert.equal(steps[2].querySelector('[role=img]').getAttribute('aria-label'), '待处理');
    assert.equal(steps[0].querySelector('small').textContent, '203 项通过');
  } finally { await view.close(); }
});

test('renders nothing when neither Goal nor checklist exists', async () => {
  const view = await mount({ responses: { goal: null, checklist: null } });
  try {
    assert.equal(view.container.querySelector('.session-progress'), null);
  } finally { await view.close(); }
});

test('a completed checklist has no current step even when the last index is retained', async () => {
  const view = await mount({ responses: { goal: null, checklist: { ...checklist, status: 'COMPLETED', currentStepIndex: 3,
    steps: checklist.steps.map(step => ({ ...step, status: 'DONE' })) } } });
  try {
    assert.equal(view.container.querySelector('[aria-current="step"]'), null);
    assert.equal(view.container.querySelector('.progress-count').textContent, '3/3');
    assert.equal(view.container.querySelector('.progress-state').textContent, '已完成');
  } finally { await view.close(); }
});

test('the compact todo trigger opens the list and Escape or an outside click closes it', async () => {
  const view = await mount({ responses: { goal: null, checklist } });
  try {
    const card = view.container.querySelector('.is-checklist');
    const trigger = card.querySelector('.progress-trigger');
    assert.equal(trigger.getAttribute('aria-label'), '待办清单');
    assert.equal(trigger.textContent, '待办1/3');
    assert.equal(card.dataset.open, 'false');
    await act(async () => trigger.click());
    assert.equal(card.dataset.open, 'true');
    assert.equal(trigger.getAttribute('aria-expanded'), 'true');
    await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.equal(card.dataset.open, 'false');
    assert.equal(document.activeElement, trigger);
    await act(async () => trigger.click());
    await act(async () => document.body.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true })));
    assert.equal(card.dataset.open, 'false');
  } finally { await view.close(); }
});

test('refresh keeps the open panel and scroll position, and the fixed header can close it', async () => {
  let hold = false;
  const pending = [];
  const requestImpl = path => {
    const value = path.includes('/checklist?') ? checklist : null;
    return hold ? new Promise(resolve => pending.push(() => resolve(value))) : Promise.resolve(value);
  };
  const view = await mount({ requestImpl });
  try {
    const card = view.container.querySelector('.is-checklist');
    const trigger = card.querySelector('.progress-trigger');
    await act(async () => trigger.click());
    const content = card.querySelector('.progress-panel-content');
    content.scrollTop = 80;
    hold = true;
    await act(async () => card.querySelector('[aria-label="刷新清单"]').click());
    assert.equal(pending.length, 2);
    assert.equal(view.container.querySelector('.is-checklist'), card);
    assert.equal(card.dataset.open, 'true');
    await act(async () => pending.forEach(resolve => resolve()));
    assert.equal(content.scrollTop, 80);
    assert.equal(card.dataset.open, 'true');
    await act(async () => card.querySelector('[aria-label="关闭清单"]').click());
    assert.equal(card.dataset.open, 'false');
    assert.equal(document.activeElement, trigger);
  } finally { await view.close(); }
});

test('status maps match the legacy GoalSteps / ChecklistSteps tables', async () => {
  const module = await import(await sourceUrl('components/SessionDetails.tsx', {
    ...recordDependencies,
    '@nextui-org/react': nextuiStub,
    '../backend': backendStub,
    './RemoteControls': controlsStub,

    '../session-prompt': promptStub,
    './Markdown': markdownStub,
  }));
  assert.equal(module.progressStatusText('ACTIVE'), '进行中');
  assert.equal(module.progressStatusText('BLOCKED'), '阻塞');
  assert.equal(module.progressStatusText('FAILED', true), '失败');
  assert.equal(module.progressStatusText('CUSTOM'), 'CUSTOM');
  assert.equal(module.progressStatusText(''), '');
  assert.equal(module.progressStepStatusText('PENDING'), '待处理');
  assert.equal(module.progressStepStatusText('SKIPPED'), '已跳过');
  assert.equal(module.progressStepStatusText('DONE'), '已完成');
  // Checklist stores RUNNING while Goal stores IN_PROGRESS for the same state.
  assert.equal(module.progressStepStatusText('RUNNING'), '进行中');
});

test('goal steps mark the running step, or the first pending one when nothing runs', async () => {
  const view = await mount({ responses: { goal: { title: 'g', status: 'ACTIVE', totalSteps: 3, doneSteps: 0, steps: [
    { index: 1, description: '一', status: 'PENDING' },
    { index: 2, description: '二', status: 'PENDING' },
  ] }, checklist: null } });
  try {
    const steps = [...view.container.querySelectorAll('.progress-step')];
    assert.ok(steps[0].classList.contains('current'), 'the first pending step is current');
    assert.ok(!steps[1].classList.contains('current'));
  } finally { await view.close(); }

  const running = await mount({ responses: { goal: { title: 'g', status: 'ACTIVE', totalSteps: 2, steps: [
    { index: 1, description: '一', status: 'PENDING' },
    { index: 2, description: '二', status: 'IN_PROGRESS' },
  ] }, checklist: null } });
  try {
    const steps = [...running.container.querySelectorAll('.progress-step')];
    assert.ok(!steps[0].classList.contains('current'), 'pending steps stop being current once something runs');
    assert.ok(steps[1].classList.contains('current'));
  } finally { await running.close(); }
});
