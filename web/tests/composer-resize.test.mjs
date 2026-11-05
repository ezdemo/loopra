import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/composer-resize.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const {
  DEFAULT_COMPOSER_HEIGHT_REM, MAX_COMPOSER_HEIGHT_REM, MAX_COMPOSER_HEIGHT_RATIO, MAX_STORED_COMPOSER_HEIGHTS,
  clampComposerHeight, composerHeight, composerHeightCeiling, composerSessionKey, nudgeComposerHeight, resizeComposerHeight, storeComposerHeight,
} = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

const FLOOR = 6.5;

test('the default height is the floor, so a drag can only grow the box', () => {
  // 16px per rem: a 96px upward drag adds 6rem.
  assert.equal(resizeComposerHeight(FLOOR, -96, 16, FLOOR, 20), 12.5);
  // Dragging down past the default clamps at the default instead of shrinking it.
  assert.equal(resizeComposerHeight(FLOOR + 2, 200, 16, FLOOR, 20), FLOOR);
  assert.equal(resizeComposerHeight(12, 4000, 16, FLOOR, 20), FLOOR);
  // Dragging up past the ceiling clamps at the tallest usable height.
  assert.equal(resizeComposerHeight(10, -4000, 16, FLOOR, 20), 20);
  // An unreadable root font size falls back to 16px rather than dividing by zero.
  assert.equal(resizeComposerHeight(FLOOR, -160, 0, FLOOR, 20), FLOOR + 10);
  // A home draft has a taller floor than a session composer.
  assert.equal(resizeComposerHeight(8, 400, 16, 8, 20), 8);
});

test('the ceiling caps both the rem maximum and the share of a short window', () => {
  assert.equal(composerHeightCeiling(1400, 16, FLOOR), MAX_COMPOSER_HEIGHT_REM);
  // 45% of 500px is 225px ≈ 14.06rem: a short window wins over the rem cap.
  assert.equal(composerHeightCeiling(500, 16, FLOOR), (500 * MAX_COMPOSER_HEIGHT_RATIO) / 16);
  // The floor always stays reachable, even in a tiny window.
  assert.equal(composerHeightCeiling(120, 16, 8), 8);
  // A larger type scale leaves fewer rems for the same pixels.
  assert.ok(composerHeightCeiling(600, 20.8, FLOOR) < composerHeightCeiling(600, 16, FLOOR));
});

test('arrow-key steps respect the same floor and ceiling', () => {
  assert.equal(nudgeComposerHeight(FLOOR, 1, FLOOR, 20), FLOOR + 1);
  assert.equal(nudgeComposerHeight(FLOOR, -1, FLOOR, 20), FLOOR);
  assert.equal(nudgeComposerHeight(20, 1, FLOOR, 20), 20);
  assert.equal(clampComposerHeight(Number.NaN, FLOOR, 20), FLOOR);
  assert.equal(clampComposerHeight(8.333, 0, 20), 8.33);
});

test('heights are kept per workspace and session', () => {
  assert.equal(composerSessionKey('ws', 'session-a'), 'ws/session-a');
  assert.notEqual(composerSessionKey('ws', 'session-a'), composerSessionKey('ws', 'session-b'));
  // A prepared draft in the same workspace has its own slot.
  assert.equal(composerSessionKey('ws'), 'ws/');
  const heights = storeComposerHeight({}, composerSessionKey('ws', 'session-a'), 9);
  assert.equal(composerHeight(heights, 'ws/session-a'), 9);
  // Another session is unaffected.
  assert.equal(composerHeight(heights, 'ws/session-b'), DEFAULT_COMPOSER_HEIGHT_REM);
  // Missing and invalid entries fall back to the stylesheet default.
  assert.equal(composerHeight(undefined, 'ws/session-a'), DEFAULT_COMPOSER_HEIGHT_REM);
  assert.equal(composerHeight({ 'ws/session-a': 0 }, 'ws/session-a'), DEFAULT_COMPOSER_HEIGHT_REM);
  assert.equal(composerHeight({ 'ws/session-a': Number.NaN }, 'ws/session-a'), DEFAULT_COMPOSER_HEIGHT_REM);
  // A tampered value is re-clamped on read instead of breaking the layout.
  assert.equal(composerHeight({ 'ws/session-a': 9999 }, 'ws/session-a'), MAX_COMPOSER_HEIGHT_REM);
});

test('a reset drops the entry and the least recently used sessions are evicted', () => {
  const key = 'ws/session-a';
  assert.deepEqual(storeComposerHeight({ [key]: 9 }, key, 0), {});
  let heights = {};
  for (let index = 0; index < MAX_STORED_COMPOSER_HEIGHTS + 3; index++) {
    heights = storeComposerHeight(heights, `ws/s${index}`, 6);
  }
  assert.equal(Object.keys(heights).length, MAX_STORED_COMPOSER_HEIGHTS);
  assert.equal(heights['ws/s0'], undefined);
  assert.equal(heights['ws/s2'], undefined);
  const newest = `ws/s${MAX_STORED_COMPOSER_HEIGHTS + 2}`;
  assert.equal(heights[newest], 6);
  // Touching an old session refreshes its slot instead of adding a second one.
  heights = storeComposerHeight(heights, newest, 8);
  assert.equal(Object.keys(heights).length, MAX_STORED_COMPOSER_HEIGHTS);
  assert.equal(heights[newest], 8);
});
