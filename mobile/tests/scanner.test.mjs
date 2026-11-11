import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './load-source.mjs';

test('Android scanner result polling resolves content and abort stays cancelled', async () => {
  const previous = globalThis.window;
  const fake = new EventTarget();
  const results = new Map();
  let cancelled = '';
  fake.setInterval = (callback) => Number(setTimeout(callback, 1));
  fake.clearInterval = (id) => clearTimeout(id);
  fake.LoopraQrScanner = {
    scan(id) { results.set(id, JSON.stringify({ content: 'loopra://connect?e2e=1&v=1&k=test&u=https%3A%2F%2Frelay.example', error: null })); },
    cancel(id) { cancelled = id; },
    result(id) { const value = results.get(id) || null; results.delete(id); return value; },
  };
  globalThis.window = fake;
  try {
    const { scanWithNativeBridge } = await load('scanner.ts');
    assert.match(await scanWithNativeBridge(), /^loopra:\/\/connect\?/);
    const controller = new AbortController();
    const pending = scanWithNativeBridge(controller.signal);
    controller.abort();
    await assert.rejects(pending, error => error instanceof DOMException && error.name === 'AbortError');
    assert.ok(cancelled);
  } finally {
    globalThis.window = previous;
  }
});
