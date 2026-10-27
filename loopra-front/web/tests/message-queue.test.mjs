import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Legacy Chat.vue queued messages: per-session FIFO with promote/remove.
const source = await readFile(new URL('../src/message-queue.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { enqueue, moveQueued, nextQueued, promoteQueued, queueFor, removeQueued, restoreQueuedDraft } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

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

test('restoring a queued draft retains full text, images, documents and referenced context', () => {
  const attached = { ...message('second', 'original\nprompt'), context: {
    files: ['report.pdf', 'src/main.ts'], projects: ['project'], skills: ['review'],
    attachments: [{ name: 'report.pdf', text: 'full report', size: 123 }, { name: 'image.png', image: 'data:image/png;base64,abc', size: 456 }],
  } };
  const restored = restoreQueuedDraft(attached, '', { files: [], projects: [], skills: [] });
  assert.equal(restored.draft, attached.text);
  assert.deepEqual(restored.context.attachments, attached.context.attachments);
  assert.deepEqual(restored.context.projects, ['project']);
  assert.deepEqual(restored.context.skills, ['review']);
  assert.deepEqual(restored.context.files, ['report.pdf', 'src/main.ts', 'image.png']);
  assert.deepEqual(attached.context.files, ['report.pdf', 'src/main.ts']);
});

test('restoring preserves an existing draft and keeps distinct same-name images', () => {
  const queued = { ...message('image', ''), context: { files: ['image.png'], projects: ['one'], skills: ['review'], attachments: [{ name: 'image.png', image: 'queued image' }] } };
  const current = { files: ['image.png', 'notes.md'], projects: ['two'], skills: ['review'], attachments: [{ name: 'image.png', image: 'draft image' }] };
  const restored = restoreQueuedDraft(queued, 'unsent text', current);
  assert.equal(restored.draft, 'unsent text');
  assert.deepEqual(restored.context.files, ['image.png', 'notes.md', 'image (2).png']);
  assert.deepEqual(restored.context.attachments.map(file => file.image), ['queued image', 'draft image']);
  assert.deepEqual(restored.context.projects, ['one', 'two']);
  assert.deepEqual(restored.context.skills, ['review']);
  assert.equal(current.attachments[0].name, 'image.png');
  assert.equal(restoreQueuedDraft({ ...queued, text: 'queued text' }, 'draft text', current).draft, 'queued text\n\ndraft text');
  const duplicate = restoreQueuedDraft(queued, '', queued.context);
  assert.equal(duplicate.context.attachments.length, 1);
});

test('moving messages inserts in both directions and leaves other sessions untouched', () => {
  const queue = { a: [message('one'), message('two'), message('three'), message('four')], b: [message('other')] };
  const down = moveQueued(queue, 'a', 'one', 'three');
  assert.deepEqual(down.a.map(item => item.id), ['two', 'three', 'one', 'four']);
  const up = moveQueued(down, 'a', 'four', 'two');
  assert.deepEqual(up.a.map(item => item.id), ['four', 'two', 'three', 'one']);
  assert.equal(up.b, queue.b);
  assert.deepEqual(queue.a.map(item => item.id), ['one', 'two', 'three', 'four']);
  assert.equal(moveQueued(queue, 'a', 'one', 'one'), queue);
  assert.equal(moveQueued(queue, 'a', 'missing', 'one'), queue);
  assert.equal(moveQueued(queue, 'a', 'one', 'missing'), queue);
});
