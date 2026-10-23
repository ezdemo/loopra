import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionRuns, sessionRunKey, draftRunKey, isRunView } from './helpers/session-runs.mjs';

const server = 'http://loopra.test';
const session = { id: 'project/chat', name: 'chat', workspaceHash: 'project' };
const input = (overrides = {}) => ({ server, requestId: crypto.randomUUID(), controller: new AbortController(), ...overrides });

test('run identity is isolated by backend and session and only the owner can finish or update speed', () => {
  const runs = new SessionRuns();
  const key = sessionRunKey(server, session.id);
  const a = runs.claim(key, input({ session }));
  assert.equal(runs.claim(key, input({ session })), undefined);
  const b = runs.claim(sessionRunKey('http://other-server', session.id), input({ server: 'http://other-server', session }));
  runs.setSpeed(a, { tokensPerSecond: 10 });
  runs.setSpeed(b, { tokensPerSecond: 20 });
  assert.equal(runs.finish(a, true), true);
  const replacement = runs.claim(key, input({ session }));
  assert.equal(runs.finish(a), false);
  runs.setSpeed(a, { tokensPerSecond: 99 });
  assert.equal(runs.speed(key), undefined);
  assert.equal(runs.get(key), replacement);
  assert.equal(runs.speed(b.key).tokensPerSecond, 20);
});

test('a prepared draft transfers its ownership to a session without interrupting other drafts', () => {
  const runs = new SessionRuns();
  const draft = draftRunKey(server, 'project', 'native', 1);
  const nextDraft = draftRunKey(server, 'project', 'native', 2);
  const a = runs.claim(draft, input());
  const b = runs.claim(nextDraft, input());
  assert.equal(isRunView(a, { server, activeId: null, draftKey: draft }), true);
  assert.equal(isRunView(a, { server, activeId: null, draftKey: nextDraft }), false);
  assert.equal(runs.bind(a, session), true);
  assert.equal(runs.get(draft), a, 'the creating view retains its stop handle while title persistence is pending');
  assert.equal(runs.claim(draft, input()), undefined, 'the same draft cannot be submitted again after binding');
  assert.equal(runs.get(sessionRunKey(server, session.id)), a);
  assert.equal(runs.get(nextDraft), b);
  assert.equal(runs.bind(b, session), false, 'binding must not replace an already running session');
  assert.equal(isRunView(a, { server, activeId: session.id }), true);
  assert.deepEqual([...runs.runningIds(server)], [session.id]);
  runs.finish(a);
  assert.equal(runs.get(draft), undefined);
});

test('completion marks only the background owner unread and preserves its finished speed', () => {
  const runs = new SessionRuns();
  const a = runs.claim(sessionRunKey(server, session.id), input({ session }));
  runs.setSpeed(a, { tokensPerSecond: 12 });
  runs.finish(a, true);
  assert.deepEqual([...runs.unreadIds(server, [session])], [session.id]);
  assert.deepEqual(runs.speed(a.key), { tokensPerSecond: 12, avgTokensPerSecond: 12, done: true });
  runs.markRead(server, session.id);
  assert.equal(runs.unreadIds(server, [session]).size, 0);
});

test('detaching a backend aborts its own subscriptions and ignores late cleanup while another backend runs', () => {
  const runs = new SessionRuns();
  let notifications = 0;
  const unsubscribe = runs.subscribe(() => notifications++);
  const a = runs.claim(sessionRunKey(server, session.id), input({ session }));
  const b = runs.claim(sessionRunKey('other', session.id), input({ server: 'other', session }));
  runs.detach(server);
  assert.equal(a.controller.signal.aborted, true);
  assert.equal(b.controller.signal.aborted, false);
  assert.equal(runs.finish(a), false);
  assert.equal(runs.hasActive('other'), true);
  unsubscribe();
  const count = notifications;
  runs.detach();
  assert.equal(b.controller.signal.aborted, true);
  assert.equal(notifications, count);
});

test('four parallel streams leave a bounded admission limit and a finished owner releases its slot', () => {
  const runs = new SessionRuns();
  const active = Array.from({ length: 4 }, (_, i) => runs.claim(sessionRunKey(server, String(i)), input()));
  assert.ok(active.every(Boolean));
  assert.equal(runs.count(server), 4);
  const next = sessionRunKey(server, 'next');
  assert.equal(runs.claim(next, input()), undefined);
  assert.ok(runs.claim(sessionRunKey('other', 'one'), input({ server: 'other' })), 'limits apply per backend');
  runs.finish(active[0]);
  assert.ok(runs.claim(next, input()));
  assert.throws(() => new SessionRuns(0));
});
