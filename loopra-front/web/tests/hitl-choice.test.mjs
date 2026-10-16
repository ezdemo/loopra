import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// A suspended HITL/ask_choice turn is never persisted, so the reload that ends
// the stream must reattach the pending card instead of wiping it: the previous
// behaviour dropped the card the instant it appeared.
test('the post-stream reload reattaches a still-pending choice', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /attachPendingChoices\(historyMessages\(history\), unresolvedChoices\(petAnswer\.blocks\)\)/);
  // The old unconditional skip that caused the flash is gone.
  assert.doesNotMatch(app, /!pendingChoice/);
});

// A ready-made answer is a control reply, not typed input: it must not add a
// user bubble or clear whatever the user was typing.
test('automatic choice answers send silently without a user bubble', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /const silent = !!action \|\| autoAnswer;/);
  assert.match(app, /if \(!autoAnswer\) \{ setDraft\(''\); setComposerContext\(emptyContext\); setMenu\(null\); \}/);
  assert.match(app, /for \(const value of outgoing\) await sendMessage\(value, undefined, undefined, false, true\)/);
});

// Legacy Chat.vue attached outgoing images to the local user bubble so they show
// before any history reload.
test('the local user bubble carries outgoing images', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /images: \(context\.attachments \|\| \[\]\)\.flatMap\(file => file\.image \? \[file\.image\] : \[\]\)/);
});

// An approval must not disturb the run's rhythm: the resumed stream lands in the
// very bubble the suspended turn left behind, so there is no second bubble, no
// second timer and no visible seam — it reads like a run with no options at all.
test('an auto-answered choice resumes the suspended turn in place', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.ok(app.includes("const resumed = autoAnswer ? source?.messages.filter(entry => entry.role === 'assistant').at(-1) : undefined;"));
  assert.ok(app.includes('const answerId = resumed?.id || crypto.randomUUID();'));
  // A continuation reopens the existing bubble (timer ticks again); only a fresh
  // send inserts a new one.
  assert.match(app, /if \(resumed\) setSessions\(current => current\.map\(item => item\.id === id \? \{ \.\.\.item, messages: item\.messages\.map\(entry => entry\.id === answerId \? \{ \.\.\.entry, finishedAt: undefined \} : entry\) \} : item\)\);/);
  assert.ok(app.includes('else setSessions(current => current.map(item => item.id === id ? { ...item, messages: silent ?'));
});

// Choice cards are answered above the composer, never in the transcript, and they
// must not fold the turn either: with no final body yet, the 思考/工具 already run
// stay visible and only the "用时" summary is added on top.
test('choice cards never render and never fold the turn away', async () => {
  const [renderer, conversation] = await Promise.all([
    readFile(new URL('../src/components/BlockRenderer.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/Conversation.tsx', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(renderer, /ChoiceBlock|block-choice/);
  assert.ok(conversation.includes("splitAssistantBlocks(blocks.filter(block => block.type !== 'choice'))"));
  assert.ok(conversation.includes("const pending = blocks.some(block => block.type === 'choice' && !block.selected);"));
  assert.ok(conversation.includes('{(process.length > 0 || streaming || pending) &&'));
});
