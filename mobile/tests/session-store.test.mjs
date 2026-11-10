import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './load-source.mjs';

const { MobileSessionStore, threadId, modelChoices } = await load('session-store.ts');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const thread = (name, workspaceHash = 'project') => ({ name, workspaceHash, id: threadId(workspaceHash, name), mtime: 1, messageCount: 0, agentId: 'native' });
const options = { workspaceHash: 'project', agentId: 'native' };
function fixture() {
  const calls = [];
  let status = { running: false };
  let history = [];
  let event;
  let streamSignal;
  const gate = deferred();
  const api = {
    async request(path, method = 'GET', body, signal) {
      signal?.throwIfAborted(); calls.push({ path, method, body });
      if (path === '/workspaces') return [{ hash: 'project', name: 'Project', path: '/project' }];
      if (path === '/config') return { model: 'demo', modelChannels: [] };
      if (path === '/agent-engines') return [{ id: 'native', name: 'Native', available: true }];
      if (path.startsWith('/sessions?')) return path.includes('project') ? [thread('first')] : [];
      if (path === '/agent-engines/prepare') return { sessionName: 'created', agentId: 'native' };
      if (path.startsWith('/agent/session-status?')) return status;
      if (path.startsWith('/agent/history?')) return history;
      if (path.startsWith('/chat/permissions?')) return [];
      if (path.startsWith('/chat/elicitations?')) return [];
      if (method === 'POST') return {};
      throw new Error(`unexpected ${path}`);
    },
    async stream(body, onEvent, signal) {
      calls.push({ path: '/chat/stream', body }); event = onEvent; streamSignal = signal;
      await Promise.race([gate.promise, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
    },
  };
  return { api, calls, gate, emit: value => event(value), setStatus: value => { status = value; }, setHistory: value => { history = value; }, signal: () => streamSignal };
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

test('stream updates its owning thread after navigation and duplicate sends are rejected', async () => {
  const f = fixture(); const store = new MobileSessionStore(f.api);
  await store.select(thread('first'));
  let accepted = false;
  const sending = store.send('hello', options, false, () => { accepted = true; });
  assert.equal(accepted, true);
  assert.equal(store.getSnapshot().views[thread('first').id].running, true);
  await assert.rejects(store.send('duplicate', options), /仍在回复/);
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

test('new thread is prepared once and uses the original API plus model overrides', async () => {
  const f = fixture(); const store = new MobileSessionStore(f.api);
  const sending = store.send('create', { ...options, model: { name: 'model', channel: 'channel' }, effort: 'high' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.getSnapshot().selected.name, 'created');
  const sent = f.calls.find(call => call.path === '/chat/stream').body;
  assert.equal(sent.sessionName, 'created'); assert.equal(sent.workspaceHash, 'project');
  assert.equal(sent.model, 'model'); assert.equal(sent.modelChannelId, 'channel'); assert.equal(sent.reasoningEffort, 'high');
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
