import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

test('completion sound waits for the send gesture and releases audio nodes after playback', async () => {
  const source = await readFile(new URL('../src/notifications.ts', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  const { prepareCompletionSound, playCompletionSound } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
  const previousWindow = globalThis.window;
  const previousAudio = globalThis.AudioContext;
  const events = [];
  class TestAudio {
    state = 'suspended'; currentTime = 1; destination = {};
    resume() { this.state = 'running'; events.push('resume'); return Promise.resolve(); }
    createOscillator() {
      return { connect() {}, frequency: { setValueAtTime() {} }, start() { events.push('start'); },
        stop(time) { events.push(time); this.onended(); }, disconnect() { events.push('release oscillator'); } };
    }
    createGain() {
      return { connect() {}, disconnect() { events.push('release gain'); },
        gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} } };
    }
  }
  try {
    globalThis.window = {};
    assert.doesNotThrow(prepareCompletionSound); // Audio is optional in unsupported browsers.
    playCompletionSound();
    assert.deepEqual(events, []);
    globalThis.window.AudioContext = TestAudio;
    globalThis.AudioContext = TestAudio;
    prepareCompletionSound(); playCompletionSound();
    assert.deepEqual(events, ['resume', 'start', 1.3, 'release oscillator', 'release gain']);
  } finally {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousAudio === undefined) delete globalThis.AudioContext; else globalThis.AudioContext = previousAudio;
  }
});
