import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './load-source.mjs';

const { clampDockThumb, dockPageAt } = await load('dock-drag.ts');

test('dock thumb follows and clamps to the track before snapping to the nearest page', () => {
  assert.equal(clampDockThumb(-12, 216), 0);
  assert.equal(clampDockThumb(90, 216), 90);
  assert.equal(clampDockThumb(250, 216), 216);
  assert.equal(dockPageAt(44, 216), 'threads');
  assert.equal(dockPageAt(108, 216), 'projects');
  assert.equal(dockPageAt(0, 0), 'projects');
});
