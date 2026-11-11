import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './load-source.mjs';

const { MobileSessionStore, threadId, modelChoices } = await load('session-store.ts');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const until = async (check, message = 'condition timed out') => {
  const deadline = Date.now() + 1500;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
const thread = (name, workspaceHash = 'project') => ({ name, workspaceHash, id: threadId(workspaceHash, name), mtime: 1, messageCount: 0, agentId: 'native' });
const options = { workspaceHash: 'project', agentId: 'native' };
const agentConfig = () => [
  { id: 'model', name: '模型', category: 'model', type: 'select', currentValue: 'primary:model-a', options: [{ value: 'primary:model-a', name: 'Primary / Model A' }, { value: 'primary:model-b', name: 'Primary / Model B' }] },
  { id: 'mode', name: '权限模式', category: 'mode', type: 'select', currentValue: 'approval', options: [{ value: 'approval', name: '按需审批' }, { value: 'auto', name: '自动审批' }] },
  { id: 'effort', name: '思考强度', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'low', name: '低' }, { value: 'high', name: '高' }] },
  { id: 'web_search', name: '联网搜索', type: 'boolean', currentValue: false, options: [] },
];
function fixture() {
  const calls = [];
  let status = { running: false };
  let history = [];
  let event;
  let streamSignal;
  let config = agentConfig();
  const gate = deferred();
  const streams = [];
  const api = {
    async request(path, method = 'GET', body, signal) {
      signal?.throwIfAborted(); calls.push({ path, method, body });
      if (path === '/workspaces') return [{ hash: 'project', name: 'Project', path: '/project' }];
      if (path === '/config') return { model: 'demo', modelChannels: [] };
      if (path === '/agent-engines') return [{ id: 'native', name: 'Native', available: true }];
      if (path.startsWith('/sessions?')) return path.includes('project') ? [thread('first')] : [];
      if (path === '/agent-engines/prepare') return { sessionName: 'created', agentId: body?.agentId || 'native', configOptions: config };
      if (path.startsWith('/agent-engines/config?')) return { configOptions: config };
      if (path === '/agent-engines/config' && method === 'PUT') {
        config = config.map(option => option.id === body.configId ? { ...option, currentValue: body.value } : option);
        return { configOptions: config };
      }
      if (path.startsWith('/agent/session-status?')) return status;
      if (path.startsWith('/agent/history?')) return history;
      if (path.startsWith('/chat/permissions?')) return [];
      if (path.startsWith('/chat/elicitations?')) return [];
      if (method === 'POST') return {};
      throw new Error(`unexpected ${path}`);
    },
    async stream(body, onEvent, signal) {
      calls.push({ path: '/chat/stream', body });
      const current = streams.length === 0 ? gate : deferred();
      streams.push({ body, signal, gate: current }); event = onEvent; streamSignal = signal;
      await Promise.race([current.promise, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
    },
  };
  return { api, calls, gate, streams, emit: value => event(value), setStatus: value => { status = value; }, setHistory: value => { history = value; }, setConfig: value => { config = value; }, signal: () => streamSignal };
}

test('phone catalog includes pure chat and uses collision-free project/session identities', async () => {
  const f = fixture(); const store = new MobileSessionStore(f.api);
  await store.refresh();
  assert.equal(store.getSnapshot().loading, false);
  assert.equal(store.getSnapshot().workspaces[0].hash, '__loopra_chat__');
  assert.equal(store.getSnapshot().threads[0].id, threadId('project', 'first'));
  assert.notEqual(threadId('a/b', 'c'), threadId('a', 'b/c'));
  assert.deepEqual(modelChoices({ modelChannels: [{ id: 'p', models: [{ name: 'm', displayName: 'Model' }] }] }), [{ id: '["p","m"]', name: 'm', channel: 'p', label: 'Model' }]);
  store.dispose();
});

test('stream updates its owning thread after navigation and same-session sends queue', async () => {
  const f = fixture(); const store = new MobileSessionStore(f.api);
  await store.select(thread('first'));
  let accepted = false;
  const sending = store.send('hello', options, false, () => { accepted = true; });
  assert.equal(accepted, true);
  assert.equal(store.getSnapshot().views[thread('first').id].running, true);
  let queued = false;
  assert.equal(await store.send('follow up', options, false, () => { queued = true; }), true);
  assert.equal(queued, true);
  assert.deepEqual(store.getSnapshot().views[thread('first').id].queued.map(item => item.text), ['follow up']);
  await store.select(thread('second'));
  f.emit({ type: 'reasoning', content: 'thinking' });
  f.emit({ type: 'tool_call', toolCallId: 'tool1', name: 'read', args: { path: 'a.ts' } });
  f.emit({ type: 'tool_result', toolCallId: 'tool1', result: 'result', status: 'completed' });
  f.emit({ type: 'content', content: 'answer' });
  assert.equal(store.getSnapshot().selected.name, 'second');
  assert.equal(store.getSnapshot().views[thread('first').id].messages.at(-1).text, 'answer');
  assert.equal(store.getSnapshot().views[thread('second').id].messages.length, 0);
  f.gate.resolve(); await sending; store.dispose();
});

test('queued messages stay FIFO and drain automatically after each reply', async () => {
  const f = fixture(); const store = new MobileSessionStore(f.api);
  await store.select(thread('first'));
  const sending = store.send('first', options);
  await store.send('second', options);
  await store.send('third', options);
  assert.deepEqual(store.getSnapshot().views[thread('first').id].queued.map(item => item.text), ['second', 'third']);
  f.streams[0].gate.resolve(); await sending;
  await until(() => f.streams.length === 2, 'second queued turn did not start');
  assert.equal(f.streams[1].body.message, 'second');
  assert.deepEqual(store.getSnapshot().views[thread('first').id].queued.map(item => item.text), ['third']);
  f.streams[1].gate.resolve();
  await until(() => f.streams.length === 3, 'third queued turn did not start');
  assert.equal(f.streams[2].body.message, 'third');
  assert.equal(store.getSnapshot().views[thread('first').id].queued.length, 0);
  f.streams[2].gate.resolve();
  await until(() => !store.getSnapshot().views[thread('first').id].running);
  store.dispose();
});

test('history refresh preserves the pending queue until the remote run finishes', async () => {
  const f = fixture(); const store = new MobileSessionStore(f.api);
  await store.select(thread('first'));
  f.setStatus({ running: true, requestId: 'remote-run' });
  await store.sync();
  await store.send('queued later', options);
  await store.sync();
  assert.deepEqual(store.getSnapshot().views[thread('first').id].queued.map(item => item.text), ['queued later']);
  f.setStatus({ running: false });
  await store.sync();
  await until(() => f.streams.length === 1, 'queued turn did not start after remote completion');
  assert.equal(f.streams[0].body.message, 'queued later');
  f.streams[0].gate.resolve();
  store.dispose();
});

test('promoting and removing queued messages updates their send order', async () => {
  const f = fixture(); const store = new MobileSessionStore(f.api);
  await store.select(thread('first'));
  const sending = store.send('first', options);
  await store.send('one', options);
  await store.send('two', options);
  await store.send('three', options);
  const view = () => store.getSnapshot().views[thread('first').id];
  store.promoteQueued(thread('first').id, view().queued[2].id);
  store.removeQueued(thread('first').id, view().queued[2].id);
  assert.deepEqual(view().queued.map(item => item.text), ['three', 'one']);
  f.streams[0].gate.resolve();
  await sending;
  await until(() => f.streams.length === 2);
  assert.equal(f.streams[1].body.message, 'three');
  store.dispose();
});

test('stopping the live reply drains the queue only after the backend is idle', async () => {
  const f = fixture(); const store = new MobileSessionStore(f.api);
  const original = f.api.request;
  f.api.request = async (path, ...args) => {
    const result = await original(path, ...args);
    if (path === '/chat/abort') f.setStatus({ running: false });
    return result;
  };
  await store.select(thread('first'));
  const sending = store.send('first', options);
  await store.send('after stop', options);
  f.setStatus({ running: true, requestId: f.streams[0].body.requestId });
  await store.stop();
  await sending;
  await until(() => f.streams.length === 2, 'queued turn did not start after stop');
  assert.equal(f.streams[0].signal.aborted, true);
  assert.equal(f.streams[1].body.message, 'after stop');
  f.streams[1].gate.resolve();
  store.dispose();
});

test('new thread reuses its prepared draft and sends the server-applied configuration', async () => {
  const f = fixture(); const store = new MobileSessionStore(f.api);
  const draft = await store.prepareDraft('project', 'native');
  await store.changeConfig({ workspaceHash: 'project', sessionName: draft.sessionName, agentId: 'native' }, 'model', 'primary:model-b');
  const sending = store.send('create', options);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.getSnapshot().selected.name, 'created');
  assert.equal(store.getSnapshot().configs[store.getSnapshot().selected.id].find(option => option.id === 'model').currentValue, 'primary:model-b');
  assert.equal(f.calls.filter(call => call.path === '/agent-engines/prepare').length, 1);
  const sent = f.calls.find(call => call.path === '/chat/stream').body;
  assert.equal(sent.sessionName, 'created'); assert.equal(sent.workspaceHash, 'project');
  assert.equal('model' in sent, false); assert.equal('reasoningEffort' in sent, false);
  f.gate.resolve(); await sending; store.dispose();
});

test('session and stream configuration updates expose the agent current values', async () => {
  const f = fixture(); const store = new MobileSessionStore(f.api);
  await store.select(thread('first'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.getSnapshot().configs[thread('first').id].find(option => option.id === 'effort').currentValue, 'high');
  await store.changeConfig({ workspaceHash: 'project', sessionName: 'first', agentId: 'native', threadId: thread('first').id }, 'effort', 'low');
  assert.equal(store.getSnapshot().configs[thread('first').id].find(option => option.id === 'effort').currentValue, 'low');
  await store.changeConfig({ workspaceHash: 'project', sessionName: 'first', agentId: 'native', threadId: thread('first').id }, 'web_search', true);
  assert.equal(store.getSnapshot().configs[thread('first').id].find(option => option.id === 'web_search').currentValue, true);
  const sending = store.send('hello', options);
  f.emit({ type: 'config_options', configOptions: agentConfig().map(option => option.id === 'web_search' ? { ...option, currentValue: true } : option) });
  assert.equal(store.getSnapshot().configs[thread('first').id].find(option => option.id === 'web_search').currentValue, true);
  f.gate.resolve(); await sending; store.dispose();
});

test('stop uses the exact live request ID; a failed stop keeps the stream alive', async () => {
  const f = fixture(); const original = f.api.request;
  let fail = true;
  f.api.request = async (...args) => { if (args[0] === '/chat/abort' && fail) throw new Error('stale request'); return original(...args); };
  const store = new MobileSessionStore(f.api); await store.select(thread('first'));
  const sending = store.send('hello', options);
  await assert.rejects(store.stop(), /stale request/);
  assert.equal(f.signal().aborted, false);
  fail = false; await store.stop(); await sending;
  const abort = f.calls.find(call => call.path === '/chat/abort');
  assert.equal(abort.body.requestId, f.calls.find(call => call.path === '/chat/stream').body.requestId);
  assert.equal(f.signal().aborted, true); store.dispose();
});

test('lost stream recovers desktop execution, history, approvals and user questions', async () => {
  const f = fixture(); const store = new MobileSessionStore(f.api); await store.select(thread('first'));
  const sending = store.send('hello', options);
  f.emit({ type: 'choice', permissionRequestId: 'permission', title: 'Allow?', options: [{ title: 'Allow', value: 'allow' }] });
  f.emit({ type: 'elicitation', elicitationRequestId: 'input', message: 'Name?', schema: { properties: { name: { type: 'string' } } } });
  assert.equal(store.getSnapshot().views[thread('first').id].inputs[0].elicitationRequestId, 'input');
  await store.answerInput('input', 'accept', { name: 'user' });
  const choice = store.getSnapshot().views[thread('first').id].messages.at(-1).blocks.find(block => block.type === 'choice');
  await store.answer(choice, 'allow', 'Allow', options);
  assert.equal(store.getSnapshot().views[thread('first').id].messages.at(-1).blocks.find(block => block.type === 'choice').selected, 'Allow');
  f.setStatus({ running: true, requestId: 'desktop-running' });
  f.setHistory([{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'still running' }]);
  f.gate.reject(new Error('connection lost')); await sending;
  assert.equal(store.getSnapshot().views[thread('first').id].running, true);
  assert.equal(store.getSnapshot().views[thread('first').id].requestId, 'desktop-running');
  assert.match(store.getSnapshot().views[thread('first').id].messages.at(-1).text, /still running/);
  f.setStatus({ running: false }); f.setHistory([{ role: 'assistant', content: 'finished on desktop' }]);
  await store.sync(); assert.equal(store.getSnapshot().views[thread('first').id].running, false);
  assert.equal(store.getSnapshot().views[thread('first').id].messages.at(-1).text, 'finished on desktop');
  store.dispose();
});

test('late history reads and disposed stores cannot publish into a different view', async () => {
  const f = fixture(); const old = deferred(); const original = f.api.request;
  f.api.request = (path, ...args) => path.includes('/agent/history?') && path.includes('first') ? old.promise : original(path, ...args);
  const store = new MobileSessionStore(f.api);
  const first = store.select(thread('first')); await new Promise(resolve => setImmediate(resolve));
  await store.select(thread('second')); old.resolve([{ role: 'assistant', content: 'stale' }]); await first;
  assert.equal(store.getSnapshot().selected.name, 'second');
  assert.equal(store.getSnapshot().views[thread('second').id].messages.length, 0);
  const snapshot = store.getSnapshot(); store.dispose(); await store.refresh();
  assert.equal(store.getSnapshot(), snapshot);
});
