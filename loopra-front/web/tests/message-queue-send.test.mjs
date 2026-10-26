import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
import { SessionRuns, sessionRunKey, draftRunKey, isRunView } from './helpers/session-runs.mjs';

// Execute the real App send functions with a separate scope per render. Keeping
// the first render's async continuation reproduces the stale Home closure.
const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const app = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'App');
const names = ['isSessionOccupied', 'recordSessionOccupancy', 'replaceQueue', 'queueMessage', 'sendQueuedMessage', 'guideQueuedMessage', 'sendMessage', 'stopGeneration', 'stopRemoteRun', 'submitChoices', 'answerElicitation', 'syncSessionRun'];
const functions = app.body.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map(node => node.getText(ast)).join('\n');
const compiled = ts.transpileModule(functions, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const renderFunctions = new Function('env', `with (env) { ${compiled}; return { ${names.join(', ')} }; }`);
const queueSource = await readFile(new URL('../src/message-queue.ts', import.meta.url), 'utf8');
const queueJs = ts.transpileModule(queueSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const queue = await import('data:text/javascript;base64,' + Buffer.from(queueJs).toString('base64'));
const composerSource = await readFile(new URL('../src/composer.ts', import.meta.url), 'utf8');
const composerJs = ts.transpileModule(composerSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { composeOutgoing, withoutWorkspaceContext } = await import('data:text/javascript;base64,' + Buffer.from(composerJs).toString('base64'));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('async send did not reach the expected state');
}
const original = { id: 'a/first', name: 'first', workspaceHash: 'a', workspace: 'A', agentId: 'external', messages: [], kind: 'remote' };
const other = { id: 'b/other', name: 'other', workspaceHash: 'b', workspace: 'B', agentId: 'native', messages: [], kind: 'remote' };
const context = { projects: [], skills: [], files: [], attachments: [] };

function harness() {
  const streams = [], requests = [], notices = [], drafts = [];
  const running = new Set();
  const state = { options: {}, plan: undefined, inputs: {}, configs: {}, editors: {}, logs: [], selections: [] };
  let abortGate;
  const shared = {
    server: 'http://localhost:4567', occupiedSessionsRef: { current: new Set() },
    setOccupiedSessions: () => {}, isSessionOccupiedError: () => false,
    ...queue, runs: new SessionRuns(), sessionRunKey, draftRunKey, isRunView, sendingQueued: { current: new Set() },
    composerViewRef: { current: { server: 'http://localhost:4567', activeId: null, draft: 'unrelated draft', draftKey: '' } },
    sendMessageRef: { current: undefined }, sessionsRef: { current: [] }, queuedRef: { current: {} }, remoteRunRef: { current: null },
    backend: { status: 'connected', ready: true }, workspaces: [{ hash: 'a', name: 'A' }, { hash: 'b', name: 'B' }],
    CHAT_WORKSPACE: { hash: '__loopra_chat__' }, isChatWorkspace: workspace => workspace?.hash === '__loopra_chat__',
    projectWorkspaces: [{ hash: 'a', name: 'A' }, { hash: 'b', name: 'B' }],
    preferences: { sound: false, notifications: false }, composerContext: context, emptyContext: context, composerConfigBusy: false,
    LARGE_PASTE_THRESHOLD_CHARS: 10000, preparedNewSession: { current: null },
    seededConfigAt: { current: {} }, setAgentConfigs: update => { state.configs = update(state.configs); },
    userScrolledAway: { current: false }, scrollArea: { current: null }, agentConfigKey: 'a::external',
    notify: text => notices.push(text), composeOutgoing: text => text, withoutWorkspaceContext,
    sessionQuery: target => `workspaceHash=${target.workspaceHash}&sessionName=${target.name}`,
    sessionRoute: (target, suffix = '') => `/sessions/${target.name}${suffix}`, remoteSession: () => ({ ...original, messages: [] }),
    setSessions: update => { shared.sessionsRef.current = update(shared.sessionsRef.current); },
    setQueuedMessages: () => {}, setActiveId: id => { state.selections.push(id); shared.composerViewRef.current.activeId = id; },
    setDraft: text => drafts.push(text), setComposerContext: () => {}, setMenu: () => {}, setShowScrollBtn: () => {},
    setPendingInputs: update => { state.inputs = update(state.inputs); }, notifyWorkspaceChanged: () => {}, setPetReply: () => {},
    setComposerOptions: update => { state.options = update(state.options); }, setPendingPlan: value => { state.plan = value; },
    setAcpPlans: () => {}, setAcpCommands: () => {}, setRemoteRun: () => {},
    setWorkspaceEditors: update => { state.editors = update(state.editors); }, emptyWorkspaceTabs: { tabs: [] },
    ensureSubAgentTab: (tabs, entry) => ({ ...tabs, tabs: [...tabs.tabs, entry] }),
    chatLogs: { push: entry => state.logs.push(entry) },
    resolveChoiceBlock: (blocks, id, label) => blocks.map(block => block.id === id ? { ...block, selected: label } : block),
    petReplyPreview: () => '', acpStopMessage: () => '',
    applyEvent: (message, event) => ({ ...message, text: message.text + (event.content || '') }),
    // Keep idle polling fast, but asynchronous, in these race regression tests.
    setTimeout: callback => setTimeout(callback, 1),
    api: {
      async request(path, method, body) {
        requests.push({ path, method, body });
        if (path === '/chat/abort') { await abortGate?.promise; return; }
        if (path.startsWith('/agent/session-status')) return { running: running.has(new URLSearchParams(path.split('?')[1]).get('sessionName')) };
        if (path.startsWith('/agent/history')) return [];
        if (path === '/agent-engines/prepare') return { sessionName: 'first', agentId: 'external', configOptions: [] };
      },
      stream(body, onEvent, signal) {
        const done = deferred();
        running.add(body.sessionName);
        streams.push({ body, signal, emit: onEvent, fail: error => { running.delete(body.sessionName); done.reject(error); }, finish: () => { running.delete(body.sessionName); done.resolve(); } });
        signal.addEventListener('abort', () => done.reject(new Error('aborted')), { once: true });
        return done.promise;
      },
    },
  };
  function render(session) {
    const homeRunKey = draftRunKey(shared.server, session?.workspaceHash || 'a', session?.agentId || 'external', 0);
    shared.composerViewRef.current = { server: shared.server, activeId: session?.id || null, draft: 'unrelated draft', draftKey: homeRunKey };
    const env = { ...shared, homeRunKey, session, currentWorkspace: shared.workspaces.find(item => item.hash === (session?.workspaceHash || 'a')), workspace: session?.workspaceHash || 'a', agentId: session?.agentId || 'external', draft: 'unrelated draft', remoteRun: session ? { id: session.id, requestId: 'remote-request' } : null };
    const functions = renderFunctions(env);
    shared.sendMessageRef.current = functions.sendMessage;
    return functions;
  }
  function enqueue(id, text) { shared.queuedRef.current = queue.enqueue(shared.queuedRef.current, original.id, { id, text, context }); }
  return { shared, state, streams, requests, notices, drafts, render, enqueue,
    setRunning: value => { if (value) running.add(original.name); else running.clear(); }, delayAbort: () => (abortGate = deferred()) };
}

test('two sessions stream concurrently and background events stay with their owner', async () => {
  const h = harness(); h.shared.sessionsRef.current = [original, other];
  const a = h.render(original).sendMessage('A');
  const b = h.render(other).sendMessage('B');
  await until(() => h.streams.length === 2);
  h.streams[0].emit({ type: 'content', content: 'A-only' });
  h.streams[1].emit({ type: 'content', content: 'B-only' });
  h.streams[0].emit({ type: 'token_speed', tokensPerSecond: 11 });
  h.streams[1].emit({ type: 'token_speed', tokensPerSecond: 22 });
  h.streams[0].emit({ type: 'plan_submitted', plan: 'A-plan' });
  assert.equal(h.state.plan, undefined, 'background plans must not replace the selected composer');
  h.streams[1].emit({ type: 'plan_submitted', plan: 'B-plan' });
  h.streams[0].emit({ type: 'config_options', configOptions: [{ id: 'A-config' }] });
  h.streams[1].emit({ type: 'config_options', configOptions: [{ id: 'B-config' }] });
  h.streams[0].emit({ type: 'log', message: 'A-log' });
  h.streams[1].emit({ type: 'log', message: 'B-log' });
  h.streams[0].emit({ type: 'sub_start', subSessionId: 'A-child', name: 'child' });
  assert.equal(h.state.editors[`${h.shared.server}/a`].tabs[0].sessionName, original.name);
  assert.equal(h.state.editors[`${h.shared.server}/b`], undefined);
  assert.equal(h.state.configs[original.id][0].id, 'A-config');
  assert.equal(h.state.configs[other.id][0].id, 'B-config');
  assert.equal(h.state.plan, 'B-plan');
  assert.deepEqual(h.state.logs.map(log => log.message), ['B-log']);
  assert.equal(h.shared.runs.speed(sessionRunKey(h.shared.server, original.id)).tokensPerSecond, 11);
  assert.equal(h.shared.runs.speed(sessionRunKey(h.shared.server, other.id)).tokensPerSecond, 22);
  assert.equal(h.shared.sessionsRef.current[0].messages.at(-1).text, 'A-only');
  assert.equal(h.shared.sessionsRef.current[1].messages.at(-1).text, 'B-only');
  h.streams[0].finish(); await a;
  assert.ok(h.shared.runs.get(sessionRunKey(h.shared.server, other.id)), 'A finishing must not clear B');
  assert.equal(h.shared.runs.speed(sessionRunKey(h.shared.server, other.id)).done, false);
  assert.ok(h.shared.runs.unreadIds(h.shared.server, h.shared.sessionsRef.current).has(original.id));
  h.streams[1].finish(); await b;
  assert.equal(h.shared.runs.hasActive(h.shared.server), false);
});

test('four sessions in one workspace run concurrently and the fifth retains its draft until a slot opens', async () => {
  const h = harness();
  const sessions = Array.from({ length: 5 }, (_, index) => ({ ...original, id: `a/session-${index}`, name: `session-${index}`, messages: [] }));
  h.shared.sessionsRef.current = sessions;
  const sends = sessions.slice(0, 4).map((target, index) => h.render(target).sendMessage(`task-${index}`));
  await until(() => h.streams.length === 4);
  const fifth = h.render(sessions[4]);
  const clearedDrafts = h.drafts.length;
  assert.equal(await fifth.sendMessage(), false);
  assert.equal(h.drafts.length, clearedDrafts, 'capacity refusal preserves the draft');
  assert.equal(h.streams.length, 4);
  assert.match(h.notices.at(-1), /4 个会话/);
  h.streams[0].finish(); await sends[0];
  const retry = fifth.sendMessage();
  await until(() => h.streams.length === 5);
  assert.equal(h.streams[4].body.sessionName, sessions[4].name);
  assert.equal(h.streams[4].body.message, 'unrelated draft');
  assert.equal(h.shared.runs.count(h.shared.server), 4);
  for (const stream of h.streams.slice(1)) stream.finish();
  await Promise.all([...sends.slice(1), retry]);
  assert.equal(h.shared.runs.count(h.shared.server), 0);
});

test('stopping A is deduplicated and leaves B streaming and cancellable independently', async () => {
  const h = harness(); h.shared.sessionsRef.current = [original, other];
  const a = h.render(original).sendMessage('A');
  const b = h.render(other).sendMessage('B');
  await until(() => h.streams.length === 2);
  const abort = h.delayAbort();
  const owner = h.render(original);
  const stop = owner.stopGeneration(); const duplicate = owner.stopGeneration();
  h.render(other);
  assert.equal(h.requests.filter(item => item.path === '/chat/abort').length, 1);
  assert.equal(h.requests.find(item => item.path === '/chat/abort').body.sessionName, original.name);
  abort.resolve(); await Promise.all([a, stop, duplicate]);
  assert.equal(h.streams[0].signal.aborted, true);
  assert.equal(h.streams[1].signal.aborted, false);
  assert.ok(h.shared.runs.get(sessionRunKey(h.shared.server, other.id)));
  h.streams[1].emit({ type: 'content', content: 'still-running' });
  assert.equal(h.shared.sessionsRef.current[1].messages.at(-1).text, 'still-running');
  h.streams[1].finish(); await b;
});

test('same-session duplicate sends stay queued while its next turn can start alongside B', async () => {
  const h = harness(); h.shared.sessionsRef.current = [original, other];
  const owner = h.render(original); const a = owner.sendMessage('A');
  await until(() => h.streams.length === 1);
  assert.equal(await owner.sendMessage('duplicate'), false);
  assert.equal(await owner.sendMessage(), false);
  assert.equal(h.shared.queuedRef.current[original.id].length, 1);
  const b = h.render(other).sendMessage('B');
  await until(() => h.streams.length === 2);
  h.streams[0].finish(); await a;
  await until(() => h.streams.length === 3);
  assert.equal(h.streams[2].body.sessionName, original.name);
  assert.ok(h.shared.runs.get(sessionRunKey(h.shared.server, other.id)));
  h.streams[2].finish(); h.streams[1].finish(); await b;
  await until(() => !h.shared.runs.hasActive(h.shared.server));
});

test('one stream failing does not clear the other stream or overwrite its draft', async () => {
  const h = harness(); h.shared.sessionsRef.current = [original, other];
  const a = h.render(original).sendMessage('A');
  const b = h.render(other).sendMessage('B');
  await until(() => h.streams.length === 2);
  const drafts = h.drafts.length;
  h.streams[0].fail(new Error('A-offline')); await a;
  assert.match(h.shared.sessionsRef.current[0].messages.at(-1).text, /A-offline/);
  assert.equal(h.shared.sessionsRef.current[1].messages.at(-1).text, '');
  assert.equal(h.drafts.length, drafts);
  assert.ok(h.shared.runs.get(sessionRunKey(h.shared.server, other.id)));
  h.streams[1].finish(); await b;
});

test('a background Home creation cannot steal the newly selected session or clear its draft', async () => {
  const h = harness(); h.shared.sessionsRef.current = [other];
  const prepared = deferred(); const request = h.shared.api.request;
  h.shared.api.request = (path, ...args) => path === '/agent-engines/prepare' ? prepared.promise : request(path, ...args);
  const a = h.render(undefined).sendMessage('new A');
  const b = h.render(other).sendMessage('B');
  await until(() => h.streams.length === 1);
  const drafts = h.drafts.length;
  prepared.resolve({ sessionName: original.name, agentId: original.agentId, configOptions: [] });
  await until(() => h.streams.length === 2);
  assert.equal(h.shared.composerViewRef.current.activeId, other.id);
  assert.equal(h.state.selections.length, 0);
  assert.equal(h.drafts.length, drafts);
  h.streams.forEach(stream => stream.finish()); await Promise.all([a, b]);
});

test('a new Home send keeps its provisional title local and stays cancellable without allowing duplicate sends', async () => {
  const h = harness();
  const home = h.render(undefined);
  const send = home.sendMessage('new A');
  await until(() => h.streams.length === 1);
  assert.equal(h.requests.some(item => item.path.endsWith('/title')), false, 'an initial title must not be saved as a manual rename');
  assert.equal(await home.sendMessage('duplicate'), false);
  assert.equal(h.shared.runs.count(h.shared.server), 1);
  await home.stopGeneration();
  assert.equal(h.requests.find(item => item.path === '/chat/abort').body.sessionName, original.name);
  await send;
  assert.equal(h.streams.length, 1);
  assert.equal(h.shared.runs.count(h.shared.server), 0);
});

test('sending a prepared Home conversation leaves title persistence to the backend', async () => {
  const h = harness();
  h.shared.preparedNewSession.current = { key: h.shared.agentConfigKey, target: original };
  h.shared.newAgentConfigRef = { current: null };
  h.shared.storeNewAgentConfig = () => {};
  const send = h.render(undefined).sendMessage('prepared first message');
  await until(() => h.streams.length === 1);
  assert.equal(h.shared.sessionsRef.current[0].title, 'prepared first message');
  assert.equal(h.requests.some(item => item.path === '/agent-engines/prepare' || item.path.endsWith('/title')), false);
  h.streams[0].finish();
  await send;
});

test('switching backends detaches old streams and ignores their late events and queued sends', async () => {
  const h = harness(); h.shared.sessionsRef.current = [original];
  const a = h.render(original).sendMessage('A'); await until(() => h.streams.length === 1);
  h.enqueue('queued', 'old server');
  h.shared.composerViewRef.current.server = 'http://new-server';
  h.shared.runs.detach(h.shared.server);
  h.streams[0].emit({ type: 'content', content: 'late' });
  await a;
  assert.equal(h.streams[0].signal.aborted, true);
  assert.equal(h.streams.length, 1);
  assert.equal(h.shared.sessionsRef.current[0].messages.at(-1).text, '');
  assert.equal(h.notices.length, 0);
});

test('permission answers and elicitation replies are routed to the selected session during parallel streams', async () => {
  const h = harness();
  h.shared.sessionsRef.current = [original, other].map(session => ({ ...session, messages: [{ id: 'answer', role: 'assistant', blocks: [{ id: 'choice', type: 'choice' }] }] }));
  const a = h.render(original).sendMessage('A'); const b = h.render(other).sendMessage('B');
  await until(() => h.streams.length === 2);
  h.render(original).submitChoices([{ id: 'choice', permissionRequestId: 'permission-A', value: 'approve', label: '同意' }]);
  h.render(other).submitChoices([{ id: 'choice', permissionRequestId: 'permission-B', value: 'deny', label: '拒绝' }]);
  await h.render(other).answerElicitation({ elicitationRequestId: 'input-B' }, 'accept', { answer: 'B' });
  const permissions = h.requests.filter(item => item.path === '/chat/permission').map(item => item.body);
  assert.deepEqual(permissions.map(body => [body.sessionName, body.permissionRequestId]), [[original.name, 'permission-A'], [other.name, 'permission-B']]);
  assert.equal(h.requests.find(item => item.path === '/chat/elicitation').body.sessionName, other.name);
  assert.equal(h.shared.sessionsRef.current[0].messages[0].blocks[0].selected, '同意');
  assert.equal(h.shared.sessionsRef.current[1].messages[0].blocks[0].selected, '拒绝');
  h.streams.forEach(stream => stream.finish()); await Promise.all([a, b]);
});

test('an in-flight remote status response cannot overwrite a newly started local stream', async () => {
  const h = harness(); h.shared.sessionsRef.current = [other];
  const status = deferred(); const request = h.shared.api.request;
  h.shared.api.request = (path, ...args) => path.startsWith('/agent/session-status') ? status.promise : request(path, ...args);
  const selected = h.render(other);
  const poll = selected.syncSessionRun(other, new AbortController(), { running: false });
  const b = selected.sendMessage('B'); await until(() => h.streams.length === 1);
  h.streams[0].emit({ type: 'content', content: 'local' });
  status.resolve({ running: true }); await poll;
  assert.equal(h.shared.sessionsRef.current[0].messages.at(-1).text, 'local');
  assert.equal(h.shared.remoteRunRef.current, null);
  h.streams[0].finish(); await b;
});

test('status polling refreshes the generated title during a local stream without touching its messages', async () => {
  const h = harness();
  const target = { ...other, title: 'first message' };
  h.shared.sessionsRef.current = [target];
  const selected = h.render(target);
  const sending = selected.sendMessage('B');
  await until(() => h.streams.length === 1);
  h.streams[0].emit({ type: 'content', content: 'local response' });
  const request = h.shared.api.request;
  h.shared.api.request = (path, ...args) => path.startsWith('/agent/session-status')
    ? Promise.resolve({ running: true, title: 'Generated title' }) : request(path, ...args);
  await selected.syncSessionRun(target, new AbortController(), { running: false });
  assert.equal(h.shared.sessionsRef.current[0].title, 'Generated title');
  assert.equal(h.shared.sessionsRef.current[0].messages.at(-1).text, 'local response');
  assert.equal(h.shared.remoteRunRef.current, null);
  assert.equal(h.requests.some(item => item.path.startsWith('/agent/history')), false);
  h.streams[0].finish();
  await sending;
});

test('a delayed title status cannot overwrite a manual rename or an aborted view', async () => {
  for (const abort of [false, true]) {
    const h = harness();
    const target = { ...other, title: 'first message' };
    h.shared.sessionsRef.current = [target];
    const status = deferred();
    h.shared.api.request = () => status.promise;
    const controller = new AbortController();
    const polling = h.render(target).syncSessionRun(target, controller, { running: false });
    if (abort) controller.abort();
    else h.shared.setSessions(current => current.map(item => ({ ...item, title: 'Manual title' })));
    status.resolve({ running: false, title: 'Generated title' });
    await polling;
    assert.equal(h.shared.sessionsRef.current[0].title, abort ? 'first message' : 'Manual title');
  }
});

test('interrupting the first reply waits for abort and backend idle, then keeps its session', async () => {
  const h = harness();
  const first = h.render(undefined).sendMessage('first message');
  await until(() => h.streams.length === 1);
  h.enqueue('cut-in', 'change direction');
  const active = h.render(original);
  const abort = h.delayAbort();
  active.guideQueuedMessage('cut-in');
  active.guideQueuedMessage('cut-in');
  h.render(other); // A later render must not redirect the queued turn.
  assert.equal(h.requests.filter(item => item.path === '/chat/abort').length, 1);
  assert.equal(h.streams.length, 1);
  abort.resolve();
  await until(() => h.requests.some(item => item.path.startsWith('/agent/session-status')));
  assert.equal(h.streams.length, 1, 'abort acknowledgement is not backend completion');
  h.setRunning(false);
  await until(() => h.streams.length === 2);
  assert.equal(h.requests.filter(item => item.path === '/agent-engines/prepare').length, 1);
  assert.deepEqual([h.streams[1].body.workspaceHash, h.streams[1].body.sessionName, h.streams[1].body.agentId], ['a', 'first', 'external']);
  assert.equal(h.streams[1].body.message, 'change direction');
  assert.equal(h.drafts.length, 1, 'a queued send preserves the newly edited draft');
  h.streams[1].finish();
  await first;
  await until(() => !h.shared.runs.hasActive(h.shared.server));
});

test('the initial Home callback drains multiple queued turns in the original session', async () => {
  const h = harness();
  const first = h.render(undefined).sendMessage('first message');
  await until(() => h.streams.length === 1);
  h.enqueue('second', 'second message'); h.enqueue('third', 'third message');
  h.render(other);
  h.streams[0].finish();
  await until(() => h.streams.length === 2);
  h.streams[1].finish();
  await until(() => h.streams.length === 3);
  h.streams[2].finish();
  await first;
  await until(() => !h.shared.runs.hasActive(h.shared.server));
  assert.deepEqual(h.streams.map(item => item.body.message), ['first message', 'second message', 'third message']);
  assert.ok(h.streams.every(item => item.body.sessionName === 'first' && item.body.workspaceHash === 'a'));
  assert.equal(h.requests.filter(item => item.path === '/agent-engines/prepare').length, 1);
  assert.deepEqual(h.shared.queuedRef.current[original.id], []);
});

test('guiding a remotely running reply sends an abort before polling drains its queue', async () => {
  const h = harness();
  h.shared.sessionsRef.current = [original];
  h.shared.remoteRunRef.current = original.id;
  h.enqueue('queued', 'follow up');
  h.render(original).guideQueuedMessage('queued');
  await until(() => h.requests.some(item => item.path === '/chat/abort'));
  assert.equal(h.streams.length, 0);
  assert.equal(h.requests[0].body.sessionName, 'first');
  assert.equal(h.shared.queuedRef.current[original.id].length, 1);
});

test('a failed prerequisite keeps the queued message for retry', async () => {
  const h = harness();
  h.shared.sessionsRef.current = [original];
  h.shared.backend.ready = false;
  h.enqueue('queued', 'follow up');
  await h.render(original).sendQueuedMessage(original.id);
  assert.equal(h.streams.length, 0);
  assert.equal(h.shared.queuedRef.current[original.id].length, 1);
});

test('a natural completion during a pending abort cannot start the queued turn early', async () => {
  const h = harness();
  const first = h.render(undefined).sendMessage('first message');
  await until(() => h.streams.length === 1);
  h.enqueue('queued', 'follow up');
  const abort = h.delayAbort();
  h.render(original).guideQueuedMessage('queued');
  h.streams[0].finish();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(h.streams.length, 1);
  abort.resolve();
  await until(() => h.streams.length === 2);
  h.streams[1].finish();
  await first;
  await until(() => !h.shared.runs.hasActive(h.shared.server));
});

test('an attachment-only queued turn does not pick up the current composer draft', async () => {
  const h = harness();
  h.shared.sessionsRef.current = [original];
  h.shared.queuedRef.current = queue.enqueue({}, original.id, { id: 'attachment', text: '', context: { ...context, attachments: [{ name: 'image.png', image: 'data:image/png;base64,abc' }] } });
  const sending = h.render(other).sendQueuedMessage(original.id);
  await until(() => h.streams.length === 1);
  assert.equal(h.streams[0].body.message, '请查看附件');
  assert.deepEqual(h.streams[0].body.images, ['data:image/png;base64,abc']);
  assert.deepEqual(h.drafts, []);
  h.streams[0].finish();
  await sending;
});

test('loading Agent configuration blocks sending without clearing the draft, then allows it when ready', async () => {
  const h = harness();
  h.shared.composerConfigBusy = true;
  assert.equal(await h.render(undefined).sendMessage(), false);
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.drafts, []);
  h.shared.composerConfigBusy = false;
  const sending = h.render(undefined).sendMessage();
  await until(() => h.streams.length === 1);
  assert.equal(h.streams[0].body.message, 'unrelated draft');
  h.streams[0].finish();
  await sending;
});

test('a queued pure-chat send strips old project context and preserves uploaded content', async () => {
  const h = harness();
  const chat = { ...original, id: '__loopra_chat__/first', workspaceHash: '__loopra_chat__', agentId: 'external' };
  h.shared.workspaces.push({ hash: '__loopra_chat__', kind: 'chat', name: '纯聊天' });
  h.shared.sessionsRef.current = [chat];
  h.shared.composeOutgoing = composeOutgoing;
  h.shared.queuedRef.current = queue.enqueue({}, chat.id, {
    id: 'queued-chat', text: 'x'.repeat(10001),
    context: { projects: ['A'], skills: ['old-skill'], files: ['src/private.ts', '.loopra/paste/old.txt', 'report.pdf'],
      attachments: [{ name: 'report.pdf', text: 'uploaded document' }] },
  });
  const sending = h.render(other).sendQueuedMessage(chat.id);
  await until(() => h.streams.length === 1);
  const body = h.streams[0].body;
  assert.equal(body.agentId, 'native');
  assert.equal(body.workspaceHash, '__loopra_chat__');
  assert.deepEqual(body.linkedProjectHashes, []);
  assert.equal(body.message, 'x'.repeat(10001) + '\n\n附件：report.pdf\nuploaded document');
  assert.equal(h.requests.some(item => item.path === '/files/paste'), false);
  h.streams[0].finish();
  await sending;
  assert.deepEqual(h.shared.queuedRef.current[chat.id], []);
});
