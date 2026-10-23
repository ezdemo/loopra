import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const compile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const diffUrl = dataUrl(compile(await readFile(new URL('../src/diff.ts', import.meta.url), 'utf8')));
const backendSource = compile(await readFile(new URL('../src/backend.ts', import.meta.url), 'utf8'))
  .replaceAll("'./diff'", JSON.stringify(diffUrl));
const { LoopraApiError, isSessionOccupiedError, historyMessages, isChatWorkspace, sessionQuery, applyEvent, CHAT_WORKSPACE } = await import(dataUrl(backendSource));
const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const app = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'App');
function callback(name, env) {
  const fn = app.body.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  return new Function('env', `with (env) { ${compile(fn.getText(ast))}; return ${name}; }`)(env);
}
const configuration = app.body.statements.find(node => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === 'useEffect'
  && node.expression.arguments[0].getText(ast).includes('/agent-engines/config?'));
const startConfiguration = new Function('env', `with (env) { return ${compile(`(${configuration.expression.arguments[0].getText(ast)})`)}; }`);
const settle = () => new Promise(resolve => setImmediate(resolve));
const conflict = () => new LoopraApiError('Another client owns this thread', 409, 'thread_active_writer');
const target = { id: 'project/chat', name: 'chat', workspaceHash: 'project', agentId: 'codex', messages: [] };
function environment() {
  const state = { configs: {}, busy: undefined, error: '', occupied: new Set(), sends: [], revision: 0 };
  const env = {
    server: 'http://localhost:4567', session: target, backend: { status: 'connected', ready: true },
    seededConfigAt: { current: {} }, agentConfigRequest: { current: 0 },
    occupiedSessionsRef: { current: state.occupied }, queuedRef: { current: {} },
    isSessionOccupiedError, sessionQuery, agentPreferencesReady: true,
    api: { async request() { return { configOptions: [] }; } },
    setAgentConfigBusy: value => { state.busy = typeof value === 'function' ? value(state.busy) : value; },
    setAgentConfigError: value => { state.error = value; },
    setAgentConfigs: update => { state.configs = update(state.configs); },
    setOccupiedSessions: value => { state.occupied = value; },
    setAgentConfigRevision: update => { state.revision = update(state.revision); },
    sendQueuedMessage: id => state.sends.push(id),
  };
  env.isSessionOccupied = callback('isSessionOccupied', env);
  env.recordSessionOccupancy = callback('recordSessionOccupancy', env);
  return { env, state };
}

test('configuration detects a remote writer and keeps ordinary 409 failures distinct', async () => {
  const { env, state } = environment();
  env.api.request = async () => { throw conflict(); };
  let cleanup = startConfiguration(env)();
  await settle();
  assert.equal(env.isSessionOccupied(target.id), true);
  assert.equal(state.error, '');
  assert.equal(state.busy, undefined);
  cleanup();

  const other = environment();
  other.env.api.request = async () => { throw new LoopraApiError('会话已被占用', 409); };
  cleanup = startConfiguration(other.env)();
  await settle();
  assert.equal(other.env.isSessionOccupied(target.id), false);
  assert.equal(other.state.error, '会话已被占用');
  cleanup();
});

test('retry holds the occupied notice until a successful response and resumes its queue', async () => {
  const { env, state } = environment();
  env.recordSessionOccupancy(target.id, true);
  env.seededConfigAt.current[target.id] = Date.now();
  env.queuedRef.current[target.id] = [{ id: 'pending' }];
  callback('retryAgentConfig', env)();
  assert.equal(state.revision, 1);
  let finish;
  env.api.request = () => new Promise(resolve => { finish = resolve; });
  const cleanup = startConfiguration(env)();
  assert.equal(env.isSessionOccupied(target.id), true);
  assert.ok(state.busy);
  finish({ configOptions: [] });
  await settle();
  assert.equal(env.isSessionOccupied(target.id), false);
  assert.equal(state.busy, undefined);
  assert.deepEqual(state.sends, [target.id]);
  cleanup();
});

test('failed retries stay occupied and surface network failures without erasing the state', async () => {
  const { env, state } = environment();
  env.recordSessionOccupancy(target.id, true);
  env.api.request = async () => { throw new Error('offline'); };
  const cleanup = startConfiguration(env)();
  await settle();
  assert.equal(env.isSessionOccupied(target.id), true);
  assert.equal(state.error, 'offline');
  cleanup();
});

test('aborted reads cannot occupy another conversation or clear a newer busy request', async () => {
  const { env, state } = environment();
  let failOld;
  env.api.request = () => new Promise((_resolve, reject) => { failOld = reject; });
  const cleanup = startConfiguration(env)();
  cleanup();
  state.busy = 'newer-request';
  failOld(conflict());
  await settle();
  assert.equal(env.isSessionOccupied(target.id), false);
  assert.equal(state.busy, 'newer-request');
});

test('occupation is isolated by backend and session, and blocks direct and queued sends', async () => {
  const { env } = environment();
  env.recordSessionOccupancy(target.id, true);
  assert.equal(env.isSessionOccupied('project/other'), false);
  const otherServer = { ...env, server: 'http://localhost:9999' };
  assert.equal(callback('isSessionOccupied', otherServer)(target.id), false);
  env.composerConfigBusy = false;
  assert.equal(await callback('sendMessage', env)(), false);
  await callback('sendQueuedMessage', env)(target.id);
});

function sendEnvironment() {
  const { env, state } = environment();
  state.sessions = [{ ...target, messages: [] }];
  state.draft = '  keep my draft  ';
  state.context = { projects: [], skills: [], files: [], attachments: [] };
  Object.assign(env, {
    currentWorkspace: { hash: 'project' }, workspaces: [{ hash: 'project' }], projectWorkspaces: [], agentId: 'codex', composerConfigBusy: false,
    draft: state.draft, composerContext: state.context, isChatWorkspace, historyMessages, applyEvent, CHAT_WORKSPACE,
    activeRequest: { current: undefined }, remoteRunRef: { current: null }, sessionsRef: { current: state.sessions },
    composerViewRef: { current: { server: env.server, activeId: target.id, draft: state.draft } },
    preferences: { sound: false }, LARGE_PASTE_THRESHOLD_CHARS: 100000,
    composeOutgoing: text => text, scrollArea: { current: null }, userScrolledAway: { current: false },
    notifyWorkspaceChanged() {}, setGeneratingId() {}, setLiveSpeed() {}, setShowScrollBtn() {},
    setPendingInputs() {}, setMenu() {}, notify: text => { state.notice = text; },
    setPetReply: () => { state.petError = true; },
    setSessions: update => { state.sessions = update(state.sessions); },
    setDraft: value => { state.draft = value; env.composerViewRef.current.draft = value; },
    setComposerContext: value => { state.context = value; },
    emptyContext: { projects: [], skills: [], files: [], attachments: [] },
    removeQueued: (queue, key, id) => ({ ...queue, [key]: (queue[key] || []).filter(item => item.id !== id) }),
    replaceQueue: value => { env.queuedRef.current = value; },
    api: { async request() { return []; }, async stream() { throw conflict(); } },
  });
  env.sendQueuedMessage = callback('sendQueuedMessage', env);
  return { env, state };
}

test('a conflict discovered during send restores draft and removes unaccepted optimistic messages', async () => {
  const { env, state } = sendEnvironment();
  assert.equal(await callback('sendMessage', env)(), false, state.notice);
  assert.equal(env.isSessionOccupied(target.id), true);
  assert.equal(state.draft, env.draft);
  assert.equal(state.context, env.composerContext);
  assert.deepEqual(state.sessions[0].messages, []);
  assert.equal(state.notice, undefined);
  assert.equal(state.petError, undefined);
});

test('a late send conflict does not overwrite a different conversation draft', async () => {
  const { env, state } = sendEnvironment();
  env.api.stream = async () => {
    env.composerViewRef.current = { server: env.server, activeId: 'project/other', draft: 'other draft' };
    state.draft = 'other draft';
    throw conflict();
  };
  await callback('sendMessage', env)();
  assert.equal(state.draft, 'other draft');
  assert.equal(env.isSessionOccupied(target.id), true);
  assert.equal(env.isSessionOccupied('project/other'), false);
});

test('a queued message rejected by the remote writer stays queued without a retry loop', async () => {
  const { env } = sendEnvironment();
  const item = { id: 'pending', text: 'later', context: env.composerContext };
  env.queuedRef.current[target.id] = [item];
  assert.equal(await callback('sendMessage', env)(item.text, item.context, undefined, false, false, target, item.id), false);
  assert.deepEqual(env.queuedRef.current[target.id], [item]);
});

test('new chat keeps the unsent draft and attachments while leaving the locked conversation intact', () => {
  const { env, state } = environment();
  env.draft = 'unsent';
  env.composerContext = { files: ['report.pdf'] };
  env.newSession = () => { state.draft = ''; state.context = {}; state.created = true; };
  env.setDraft = value => { state.draft = value; };
  env.setComposerContext = value => { state.context = value; };
  env.recordSessionOccupancy(target.id, true);
  callback('newChatFromOccupied', env)();
  assert.equal(state.created, true);
  assert.equal(state.draft, 'unsent');
  assert.deepEqual(state.context, { files: ['report.pdf'] });
  assert.equal(env.isSessionOccupied(target.id), true);
});

const dom = new JSDOM('<html><body></body></html>');
const globals = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
let noticeCode = compile(await readFile(new URL('../src/components/SessionOccupiedNotice.tsx', import.meta.url), 'utf8'));
for (const name of ['react/jsx-runtime', 'lucide-react']) noticeCode = noticeCode.replaceAll(`"${name}"`, JSON.stringify(import.meta.resolve(name))).replaceAll(`'${name}'`, JSON.stringify(import.meta.resolve(name)));
const { default: Notice } = await import(dataUrl(noticeCode));

test('the occupied notice exposes retry, checking and offline states without a send control', () => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const calls = [];
  const props = { busy: false, disabled: false, onRetry: () => calls.push('retry'), onNew: () => calls.push('new') };
  const render = patch => act(() => root.render(createElement(Notice, { ...props, ...patch })));
  try {
    render({});
    assert.match(host.textContent, /已在另一个应用中打开/);
    assert.equal(host.querySelector('textarea'), null);
    act(() => { host.querySelectorAll('button')[0].click(); host.querySelectorAll('button')[1].click(); });
    assert.deepEqual(calls, ['retry', 'new']);
    render({ busy: true });
    assert.equal(host.querySelector('section').getAttribute('aria-busy'), 'true');
    assert.match(host.textContent, /检查中/);
    assert.ok([...host.querySelectorAll('button')].every(button => button.disabled));
    render({ disabled: true, error: 'offline' });
    assert.match(host.textContent, /检查失败：offline/);
    assert.ok([...host.querySelectorAll('button')].every(button => button.disabled));
  } finally { act(() => root.unmount()); host.remove(); }
});
