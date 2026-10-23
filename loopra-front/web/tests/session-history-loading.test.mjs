import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const app = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'App');
const fn = app.body.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'selectSession');
const code = ts.transpileModule(fn.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settle = () => new Promise(resolve => setImmediate(resolve));

function environment() {
  const requests = [];
  const state = { sessions: ['one', 'two'].map(id => ({ id, name: id, workspaceHash: 'project', messages: [] })), notices: [], options: {} };
  const env = {
    sessions: state.sessions, narrow: false, generatingId: null,
    historyRequest: { current: undefined }, userScrolledAway: { current: true }, lastScrollTop: { current: 50 }, emptyContext: {},
    selectMainTab() {}, setWorkspace() {}, setMenu() {}, setDraft() {}, setComposerContext() {}, setShowScrollBtn() {}, setLiveSpeed() {},
    setActiveId: value => { state.active = value; },
    setHistoryState: value => { state.history = value; },
    setSessions: update => { state.sessions = update(state.sessions); },
    setComposerOptions: update => { state.options = update(state.options); }, setPendingPlan: value => { state.plan = value; },
    notify: value => state.notices.push(value), historyMessages: history => history.map(message => ({ text: message.content })),
    sessionQuery: session => `sessionName=${session.name}`, sessionRoute: session => `/sessions/${session.name}/settings`,
    api: { request(path, _method, _body, signal) { const result = deferred(); requests.push({ path, signal, ...result }); return result.promise; } },
  };
  return { state, requests, env, select: new Function('env', `with (env) { ${code}; return selectSession; }`)(env) };
}

test('history renders as soon as it arrives even while settings and plan initialization are pending', async () => {
  const { select, state, requests } = environment();
  const pending = select('one');
  assert.deepEqual(state.history, { id: 'one' });
  requests[0].resolve([{ content: 'stored conversation' }]);
  await settle();
  assert.equal(state.sessions[0].messages[0].text, 'stored conversation');
  assert.equal(state.history, undefined);
  requests[1].reject(new Error('settings failed'));
  requests[2].resolve({ mode: 'plan', pendingPlan: 'plan' });
  await pending;
  assert.equal(state.sessions[0].messages[0].text, 'stored conversation');
  assert.equal(state.options.plan, true);
  assert.match(state.notices[0], /模型设置/);
});

test('history failures are visible, preserve cached messages, and a retry can recover', async () => {
  const { select, state, requests } = environment();
  state.sessions[0].messages = [{ text: 'cached message' }];
  const pending = select('one');
  requests[0].reject(new Error('disk unavailable'));
  requests[1].resolve({ model: 'model', modelChannelId: 'channel' });
  requests[2].resolve({ mode: 'execute' });
  await pending;
  assert.equal(state.history.error, 'disk unavailable');
  assert.equal(state.sessions[0].messages[0].text, 'cached message');
  const retry = select('one');
  requests[3].resolve([{ content: 'restored' }]);
  requests[4].resolve({ model: 'model', modelChannelId: 'channel' });
  requests[5].resolve({ mode: 'execute' });
  await retry;
  assert.equal(state.history, undefined);
  assert.equal(state.sessions[0].messages[0].text, 'restored');
});

test('late history and metadata from an aborted session cannot overwrite the next session', async () => {
  const { select, state, requests } = environment();
  const old = select('one');
  const next = select('two');
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve([{ content: 'old' }]);
  requests[1].resolve({ model: 'old', modelChannelId: 'old' });
  requests[2].resolve({ mode: 'plan', pendingPlan: 'old' });
  await old;
  assert.deepEqual(state.history, { id: 'two' });
  assert.equal(state.sessions[0].messages.length, 0);
  requests[3].resolve([{ content: 'new' }]);
  requests[4].resolve({ model: 'new', modelChannelId: 'new' });
  requests[5].resolve({ mode: 'execute' });
  await next;
  assert.equal(state.options.modelId, 'new:new');
  assert.equal(state.sessions[1].messages[0].text, 'new');
});
