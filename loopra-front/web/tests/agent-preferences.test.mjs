import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Exercise the actual App callbacks, including async continuations from old renders.
const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const app = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'App');
const compile = code => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
function callback(name, env) {
  const fn = app.body.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  return new Function('env', `with (env) { ${compile(fn.getText(ast))}; return ${name}; }`)(env);
}
const hydration = app.body.statements.find(node => ts.isExpressionStatement(node)
  && ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === 'useEffect'
  && node.expression.arguments[0].getText(ast).includes("'/agent-engines/preferences'"));
const startHydration = new Function('env', `with (env) { return ${compile(`(${hydration.expression.arguments[0].getText(ast)})`) }; }`);
const settle = () => new Promise(resolve => setImmediate(resolve));
const options = [
  { id: 'model', category: 'model', type: 'select', currentValue: 'deepseek', options: [{ value: 'deepseek', name: 'DeepSeek' }] },
  { id: 'mode', type: 'select', currentValue: 'full-access', options: [{ value: 'full-access', name: 'Full access' }] },
  { id: 'effort', type: 'select', currentValue: 'max', options: [{ value: 'max', name: 'Max' }] },
];

function environment() {
  const calls = [], state = { selected: 'native', ready: undefined, error: '', drafts: [], cached: [], composer: {}, busy: undefined };
  const env = {
    server: 'http://127.0.0.1:40001', newAgentId: 'native', backend: { status: 'connected' },
    enginesError: '', selectedEngineAvailable: true,
    preparedNewSession: { current: null }, newAgentConfigRef: { current: null },
    composerViewRef: { current: { server: 'http://127.0.0.1:40001', activeId: null, draftKey: 'home' } }, homeRunKey: 'home',
    agentConfigRequest: { current: 0 },
    api: { async request(path, method, body) { calls.push({ path, method, body }); return { selectedAgent: 'codex' }; } },
    setAgentPreferencesServer: value => { state.ready = value; },
    setNewAgentId: value => { state.selected = value; },
    setAgentConfigError: value => { state.error = value; },
    setAgentPreferencesError: value => { state.error = value; },
    storeNewAgentConfig: value => { env.newAgentConfigRef.current = value; state.drafts.push(value); },
    setAgentConfigBusy: update => { state.busy = typeof update === 'function' ? update(state.busy) : update; }, setAgentConfigs: update => { state.configs = update(state.configs || {}); },
    cacheAgentConfig: (agent, values) => state.cached.push({ agent, values }),
    notify: message => { state.notice = message; },
    setComposerOptions: update => { state.composer = typeof update === 'function' ? update(state.composer) : update; }, setPendingPlan: value => { state.plan = value; },
  };
  return { env, calls, state };
}

test('backend selection wins over stale local state after a desktop port change', async () => {
  const { env, state, calls } = environment();
  const cleanup = startHydration(env)();
  await settle();
  assert.equal(state.selected, 'codex');
  assert.equal(state.ready, env.server);
  assert.deepEqual(calls.map(call => [call.path, call.method]), [['/agent-engines/preferences', 'GET']]);
  cleanup();
});

test('preparation waits for the selected Agent detection to finish', () => {
  const effect = app.body.statements.find(node => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === 'useEffect'
    && node.expression.arguments[0].getText(ast).includes('loadNewAgentConfig'));
  const create = new Function('env', `with (env) { return ${compile(`(${effect.expression.arguments[0].getText(ast)})`)}; }`);
  const calls = [];
  const env = {
    session: undefined, currentWorkspace: { hash: 'project' }, backend: { status: 'connected', ready: true },
    agentPreferencesReady: true, agentSelectionBusy: false, newAgentConfig: null,
    preparedNewSession: { current: null }, agentConfigKey: 'key', agentId: 'codex',
    selectedEngineAvailable: undefined, AbortController,
    setTimeout: callback => { calls.push(callback); return 1; }, clearTimeout: () => {},
    loadNewAgentConfig: () => {},
  };
  assert.equal(create(env)(), undefined);
  assert.equal(calls.length, 0);
  env.selectedEngineAvailable = false;
  assert.equal(create(env)(), undefined);
  assert.equal(calls.length, 0);
  env.selectedEngineAvailable = true;
  const cleanup = create(env)();
  assert.equal(calls.length, 1);
  cleanup();
});

test('retry after runtime detection failure repeats detection before preparing a session', () => {
  const { env } = environment();
  let revision = 0;
  Object.assign(env, {
    session: undefined, agentPreferencesReady: true, enginesError: 'detection timed out',
    selectedEngineAvailable: undefined,
    setEnginesRevision: update => { revision = update(revision); },
    loadNewAgentConfig: () => assert.fail('Must redetect before creating a session'),
  });
  callback('retryAgentConfig', env)();
  assert.equal(revision, 1);
});

test('first run migrates the local Agent selection and waits for durable storage', async () => {
  const { env, state, calls } = environment();
  let finishSave;
  env.newAgentId = 'claude-code';
  env.api.request = async (path, method, body) => {
    calls.push({ path, method, body });
    if (method === 'GET') return { selectedAgent: null };
    await new Promise(resolve => { finishSave = resolve; });
  };
  const cleanup = startHydration(env)();
  await settle();
  assert.equal(state.ready, undefined);
  assert.deepEqual(calls[1].body, { selectedAgent: 'claude-code' });
  finishSave();
  await settle();
  assert.equal(state.ready, env.server);
  assert.equal(state.selected, 'claude-code');
  cleanup();
});

test('aborted preference reads cannot restore an old backend selection', async () => {
  const { env, state } = environment();
  let finish;
  env.api.request = () => new Promise(resolve => { finish = resolve; });
  const cleanup = startHydration(env)();
  cleanup();
  finish({ selectedAgent: 'codex' });
  await settle();
  assert.equal(state.selected, 'native');
  assert.equal(state.ready, undefined);
});

test('unreadable preferences keep the home composer waiting and surface the failure', async () => {
  const { env, state } = environment();
  env.api.request = async () => { throw new Error('storage unavailable'); };
  const cleanup = startHydration(env)();
  await settle();
  assert.equal(state.ready, undefined);
  assert.match(state.error, /storage unavailable/);
  cleanup();
});

test('switching Agents saves selection before opening the new draft', async () => {
  const { env, state, calls } = environment();
  Object.assign(env, {
    agentId: 'native', generatingId: null, remoteRun: null, agentPreferencesReady: true, agentSelectionBusy: false,
    setAgentSelectionBusy: value => { state.busy = value; },
    newSession: () => { state.newSession = true; },
  });
  await callback('switchAgent', env)('codex');
  assert.deepEqual(calls[0].body, { selectedAgent: 'codex' });
  assert.equal(state.selected, 'codex');
  assert.equal(state.newSession, true);
  assert.equal(state.busy, false);
  state.newSession = false;
  env.api.request = async () => { throw new Error('write failed'); };
  await callback('switchAgent', env)('claude-code');
  assert.equal(state.selected, 'codex');
  assert.equal(state.newSession, false);
  assert.match(state.notice, /write failed/);
});

test('editing an existing conversation updates that Agent cache as well as its session', async () => {
  const { env, state, calls } = environment();
  env.session = { id: 'project/chat', workspaceHash: 'project', name: 'chat', agentId: 'codex' };
  env.agentId = 'codex';
  env.api.request = async (path, method, body) => {
    calls.push({ path, method, body });
    return { configOptions: options };
  };
  await callback('changeAgentConfig', env)('effort', 'max');
  assert.deepEqual(calls[0], { path: '/agent-engines/config', method: 'PUT',
    body: { workspaceHash: 'project', sessionName: 'chat', configId: 'effort', value: 'max' } });
  assert.deepEqual(state.configs['project/chat'], options);
  assert.deepEqual(state.cached, [{ agent: 'codex', values: options }]);
});

test('a slow Native configuration save cannot overwrite another conversation or clear its busy state', async () => {
  const { env, state } = environment();
  env.session = { id: 'project/A', workspaceHash: 'project', name: 'A', agentId: 'native' };
  env.agentId = 'native';
  env.composerViewRef.current.activeId = env.session.id;
  let finish;
  env.api.request = () => new Promise(resolve => { finish = resolve; });
  const saving = callback('changeAgentConfig', env)('effort', 'max');
  env.composerViewRef.current.activeId = 'project/B';
  state.composer = { modelId: 'B-model', plan: true }; state.plan = 'B-plan'; state.busy = 'B-config';
  finish({ configOptions: [...options, { id: 'plan', currentValue: 'off' }] });
  await saving;
  assert.equal(state.configs['project/A'][0].currentValue, 'deepseek');
  assert.deepEqual(state.composer, { modelId: 'B-model', plan: true });
  assert.equal(state.plan, 'B-plan');
  assert.equal(state.busy, 'B-config');
});

test('home takes the restored backend configuration without replaying browser defaults', async () => {
  const { env, state, calls } = environment();
  env.workspaces = [{ hash: 'project' }];
  env.remoteSession = value => ({ ...value, id: `project/${value.name}` });
  env.api.request = async (path, method, body) => {
    calls.push({ path, method, body });
    return { sessionName: 'draft', agentId: 'codex', configOptions: options };
  };
  await callback('loadNewAgentConfig', env)('project', 'codex');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/agent-engines/prepare');
  assert.equal(env.preparedNewSession.current.key, `${env.server}::project::codex`);
  assert.deepEqual(state.drafts.at(-1).options, options);
  assert.deepEqual(state.cached, [{ agent: 'codex', values: options }]);
});

test('new conversation discards an earlier prepared draft after session settings changed', () => {
  const { env } = environment();
  env.preparedNewSession.current = { key: 'old', target: {} };
  env.newAgentConfigRef.current = { key: 'old', options };
  Object.assign(env, {
    workspace: 'project', workspaces: [], narrow: false, historyRequest: { current: null }, providers: [],
    getModelCatalog: () => [], defaultModel: '', emptyContext: {}, userScrolledAway: { current: true },
    lastScrollTop: { current: 10 }, setTimeout: () => {}, setAgentDraftRevision: () => {},
  });
  for (const name of ['selectMainTab', 'setActiveId', 'setWorkspace', 'setChanges', 'setDraft',
    'setComposerContext', 'setLiveSpeed', 'setMenu', 'setShowScrollBtn', 'setSkillsOpen', 'setPendingPlan']) env[name] = () => {};
  callback('newSession', env)();
  assert.equal(env.preparedNewSession.current, null);
  assert.equal(env.newAgentConfigRef.current, null);
});

test('an old preparation cannot replace the Agent selected by a newer request', async () => {
  const { env, state } = environment();
  env.workspaces = [{ hash: 'project' }];
  env.remoteSession = value => value;
  let finishOld;
  env.api.request = async (_path, _method, body) => body.agentId === 'codex'
    ? await new Promise(resolve => { finishOld = resolve; })
    : { sessionName: 'claude-draft', agentId: 'claude-code', configOptions: [] };
  const load = callback('loadNewAgentConfig', env);
  const pending = load('project', 'codex');
  await load('project', 'claude-code');
  finishOld({ sessionName: 'codex-draft', agentId: 'codex', configOptions: options });
  await pending;
  assert.equal(env.preparedNewSession.current.target.name, 'claude-draft');
  assert.deepEqual(state.cached.map(item => item.agent), ['claude-code']);
});
