import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Pure logic mirrors legacy Chat.vue's `virtualWindow` computed; import the
// real module so the constants and scan rules stay in sync with the component.
const source = await readFile(new URL('../src/chat-window.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const url = 'data:text/javascript;base64,' + Buffer.from(outputText).toString('base64');
const { ESTIMATED_MESSAGE_HEIGHT, VIRTUALIZATION_THRESHOLD, messageOffsets, virtualMessageWindow } = await import(url);

test('short conversations mount everything with zero spacers', () => {
  const heights = Array(VIRTUALIZATION_THRESHOLD).fill(0);
  const view = virtualMessageWindow(heights, 0, 0);
  assert.deepEqual([view.start, view.end, view.topHeight, view.bottomHeight], [0, VIRTUALIZATION_THRESHOLD, 0, 0]);
});

test('offsets fall back to the estimated height for unmeasured rows', () => {
  const offsets = messageOffsets([0, 120, 0]);
  assert.deepEqual(offsets, [0, ESTIMATED_MESSAGE_HEIGHT, ESTIMATED_MESSAGE_HEIGHT + 120, ESTIMATED_MESSAGE_HEIGHT * 2 + 120]);
});

test('the window scrolls with the viewport and preserves total height', () => {
  const heights = Array(200).fill(100);
  const top = virtualMessageWindow(heights, 0, 800);
  assert.equal(top.start, 0); // top of the list keeps the leading edge mounted
  assert.ok(top.end >= 8);    // viewport + overscan covers ~20 rows, fewer after the trim
  assert.equal(top.topHeight, 0);

  const middle = virtualMessageWindow(heights, 10_000, 800);
  assert.ok(middle.start > 0 && middle.end < 200);
  assert.ok(middle.end > middle.start);
  // Spacers plus the mounted slice reconstruct the full scroll height.
  const mounted = (middle.end - middle.start) * 100;
  assert.equal(middle.topHeight + mounted + middle.bottomHeight, 20_000);
  // The first mounted row starts at or before the viewport top minus overscan.
  assert.ok(middle.offsets[middle.start] >= 10_000 - 1200 - 100);

  const bottom = virtualMessageWindow(heights, 20_000 - 800, 800);
  assert.equal(bottom.end, 200);
  assert.equal(bottom.bottomHeight, 0);
});

test('a viewport taller than the list keeps the trailing edge mounted', () => {
  const heights = Array(61).fill(100);
  const view = virtualMessageWindow(heights, 0, 100_000);
  assert.equal(view.end, 61);
  assert.equal(view.bottomHeight, 0);
});
