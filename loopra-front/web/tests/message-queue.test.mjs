import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Legacy Chat.vue queued messages: per-session FIFO with promote/remove.
const source = await readFile(new URL('../src/message-queue.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { enqueue, nextQueued, promoteQueued, queueFor, removeQueued } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

const message = (id, text = id) => ({ id, text, context: { files: [], projects: [], skills: [] } });

test('queued messages stay FIFO per session and never leak across sessions', () => {
  let queue = {};
  queue = enqueue(queue, 'a/1', message('first'));
  queue = enqueue(queue, 'a/1', message('second'));
  queue = enqueue(queue, 'b/1', message('other'));

  assert.deepEqual(queueFor(queue, 'a/1').map(item => item.id), ['first', 'second']);
  assert.deepEqual(queueFor(queue, 'b/1').map(item => item.id), ['other']);
  assert.deepEqual(queueFor(queue, 'missing'), []);
  assert.equal(nextQueued(queue, 'a/1').id, 'first');
  assert.equal(nextQueued(queue, 'b/1').id, 'other');
});

test('removing and promoting keep the queue consistent without mutating the input', () => {
  const queue = { 'a/1': [message('first'), message('second'), message('third')] };
  const promoted = promoteQueued(queue, 'a/1', 'third');
  assert.deepEqual(promoted['a/1'].map(item => item.id), ['third', 'first', 'second']);
  assert.deepEqual(queue['a/1'].map(item => item.id), ['first', 'second', 'third']);

  const removed = removeQueued(promoted, 'a/1', 'first');
  assert.deepEqual(removed['a/1'].map(item => item.id), ['third', 'second']);
  assert.equal(nextQueued(removed, 'a/1').id, 'third');

  // Promoting an unknown id or the head is a no-op object identity.
  assert.equal(promoteQueued(removed, 'a/1', 'nope'), removed);
  assert.equal(promoteQueued(removed, 'a/1', 'third'), removed);
  assert.equal(removeQueued(removed, 'a/1', 'nope'), removed);
});

test('draining the queue returns messages in order', () => {
  let queue = enqueue({}, 'a/1', message('one'));
  queue = enqueue(queue, 'a/1', message('two'));
  const sent = [];
  for (let next = nextQueued(queue, 'a/1'); next; next = nextQueued(queue, 'a/1')) {
    sent.push(next.id);
    queue = removeQueued(queue, 'a/1', next.id);
  }
  assert.deepEqual(sent, ['one', 'two']);
  assert.equal(nextQueued(queue, 'a/1'), undefined);
});
