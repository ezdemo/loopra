import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Execute the real App send functions with a separate scope per render. Keeping
// the first render's async continuation reproduces the stale Home closure.
const source = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const app = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'App');
const names = ['replaceQueue', 'sendQueuedMessage', 'guideQueuedMessage', 'sendMessage', 'stopGeneration', 'stopRemoteRun'];
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
  let running = false;
  let abortGate;
  const shared = {
    ...queue, activeRequest: { current: undefined }, sendingQueued: { current: new Set() },
    sendMessageRef: { current: undefined }, sessionsRef: { current: [] }, queuedRef: { current: {} }, remoteRunRef: { current: null },
    backend: { status: 'connected', ready: true }, workspaces: [{ hash: 'a', name: 'A' }, { hash: 'b', name: 'B' }],
    CHAT_WORKSPACE: { hash: '__loopra_chat__' }, isChatWorkspace: workspace => workspace?.hash === '__loopra_chat__',
    projectWorkspaces: [{ hash: 'a', name: 'A' }, { hash: 'b', name: 'B' }],
    preferences: { sound: false, notifications: false }, composerContext: context, emptyContext: context, composerConfigBusy: false,
    LARGE_PASTE_THRESHOLD_CHARS: 10000, preparedNewSession: { current: null },
    seededConfigAt: { current: {} }, setAgentConfigs: () => {},
    userScrolledAway: { current: false }, scrollArea: { current: null }, agentConfigKey: 'a::external',
    notify: text => notices.push(text), composeOutgoing: text => text, withoutWorkspaceContext,
    sessionQuery: target => `workspaceHash=${target.workspaceHash}&sessionName=${target.name}`,
    sessionRoute: target => `/sessions/${target.name}`, remoteSession: () => ({ ...original, messages: [] }),
    setSessions: update => { shared.sessionsRef.current = update(shared.sessionsRef.current); },
    setQueuedMessages: () => {}, setGeneratingId: () => {}, setLiveSpeed: () => {}, setActiveId: () => {},
    setDraft: text => drafts.push(text), setComposerContext: () => {}, setMenu: () => {}, setShowScrollBtn: () => {},
    setPendingInputs: () => {}, notifyWorkspaceChanged: () => {}, setPetReply: () => {},
    petReplyPreview: () => '', acpStopMessage: () => '',
    applyEvent: (message, event) => ({ ...message, text: message.text + (event.content || '') }),
    // Keep idle polling fast, but asynchronous, in these race regression tests.
    setTimeout: callback => setTimeout(callback, 1),
    api: {
      async request(path, method, body) {
        requests.push({ path, method, body });
        if (path === '/chat/abort') { await abortGate?.promise; return; }
        if (path.startsWith('/agent/session-status')) return { running };
        if (path.startsWith('/agent/history')) return [];
        if (path === '/agent-engines/prepare') return { sessionName: 'first', agentId: 'external', configOptions: [] };
      },
      stream(body, onEvent, signal) {
        const done = deferred();
        running = true;
        streams.push({ body, finish: () => { running = false; done.resolve(); } });
        signal.addEventListener('abort', () => done.reject(new Error('aborted')), { once: true });
        return done.promise;
      },
    },
  };
  function render(session) {
    const env = { ...shared, session, currentWorkspace: shared.workspaces.find(item => item.hash === (session?.workspaceHash || 'a')), workspace: session?.workspaceHash || 'a', agentId: session?.agentId || 'external', draft: 'unrelated draft', remoteRun: session ? { id: session.id, requestId: 'remote-request' } : null };
    const functions = renderFunctions(env);
    shared.sendMessageRef.current = functions.sendMessage;
    return functions;
  }
  function enqueue(id, text) { shared.queuedRef.current = queue.enqueue(shared.queuedRef.current, original.id, { id, text, context }); }
  return { shared, streams, requests, notices, drafts, render, enqueue,
    setRunning: value => { running = value; }, delayAbort: () => (abortGate = deferred()) };
}

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
  await until(() => !h.shared.activeRequest.current);
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
  await until(() => !h.shared.activeRequest.current);
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
  await until(() => !h.shared.activeRequest.current);
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
