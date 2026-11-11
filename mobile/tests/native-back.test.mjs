import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './load-source.mjs';

test('native back reports handled only when an in-app screen consumes it', async () => {
  const previous = globalThis.window;
  const fake = new EventTarget();
  globalThis.window = fake;
  try {
    const { installNativeBackBridge, onNativeBack } = await load('native-back.ts');
    installNativeBackBridge();
    const offMiss = onNativeBack(() => false);
    assert.equal(fake.__loopraBack(), false);
    offMiss();
    let calls = 0;
    const offHit = onNativeBack(() => { calls++; return true; });
    assert.equal(fake.__loopraBack(), true);
    assert.equal(calls, 1);
    offHit();
    assert.equal(fake.__loopraBack(), false);
  } finally {
    globalThis.window = previous;
  }
});

test('native resume notifies listeners that the app returned to the foreground', async () => {
  const previous = globalThis.window;
  const fake = new EventTarget();
  globalThis.window = fake;
  try {
    const { installNativeBackBridge, onNativeResume } = await load('native-back.ts');
    installNativeBackBridge();
    let resumes = 0;
    const off = onNativeResume(() => { resumes++; });
    fake.__loopraResume();
    assert.equal(resumes, 1);
    off();
    fake.__loopraResume();
    assert.equal(resumes, 1);
  } finally {
    globalThis.window = previous;
  }
});
