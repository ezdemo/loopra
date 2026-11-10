import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './load-source.mjs';
const { rasterizeLens } = await load('glass-optics.ts');
test('convex lens preserves the center and bends opposite rims toward the interior', () => {
  const map = rasterizeLens(220, 62);
  const pixel = (x, y) => [...map.displacement.slice((y * map.width + x) * 4, (y * map.width + x) * 4 + 4)];
  assert.deepEqual(pixel(110, 31), [128, 128, 128, 255]);
  assert.ok(pixel(110, 2)[1] > 128, 'top rim samples inward');
  assert.ok(pixel(110, 59)[1] < 128, 'bottom rim samples inward');
  assert.ok(pixel(2, 31)[0] > 128, 'left capsule end samples inward');
  assert.ok(pixel(217, 31)[0] < 128, 'right capsule end samples inward');
  assert.ok(map.scale > 5 && map.scale < 100);
  assert.equal(map.highlight[(31 * 220 + 110) * 4 + 3], 0, 'clear center emits no white light');
  assert.ok(map.highlight.some((value, index) => index % 4 === 3 && value > 20), 'rim has a specular highlight');
});
test('lens matches actual capsule and circular button dimensions and bounds allocation', () => {
  for (const [width, height] of [[63, 63], [208, 60], [256.4, 64.2]]) {
    const map = rasterizeLens(width, height);
    assert.equal(map.displacement.length, Math.round(width) * Math.round(height) * 4);
    assert.ok(Number.isFinite(map.scale));
  }
  for (const width of [0, -1, Infinity, NaN, 100000]) assert.throws(() => rasterizeLens(width, 60), /dimensions/);
});
