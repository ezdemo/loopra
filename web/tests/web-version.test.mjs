import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/web-version.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { loopraWebUrl, openLoopraWeb } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('loopraWebUrl opens the workbench root and carries the access key', () => {
  assert.equal(loopraWebUrl('http://127.0.0.1:43880', 'key with space'), 'http://127.0.0.1:43880/?rk=key+with+space');
  assert.equal(loopraWebUrl('https://loopra.example.test/nested?x=1#hash', 'secret'), 'https://loopra.example.test/nested/?rk=secret');
  assert.equal(loopraWebUrl('http://127.0.0.1:43880'), 'http://127.0.0.1:43880/');
});

test('openLoopraWeb uses the desktop external-browser bridge when present', () => {
  const opened = [];
  const previous = globalThis.window;
  globalThis.window = { electronAPI: { openExternal: url => opened.push(url) }, open: () => assert.fail('window.open should not be used') };
  try {
    openLoopraWeb('http://127.0.0.1:43880', 'abc');
    assert.deepEqual(opened, ['http://127.0.0.1:43880/?rk=abc']);
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

test('openLoopraWeb falls back to a browser tab', () => {
  const opened = [];
  const previous = globalThis.window;
  globalThis.window = { open: (url, target, features) => { opened.push([url, target, features]); return null; } };
  try {
    openLoopraWeb('http://127.0.0.1:43880', 'abc');
    assert.deepEqual(opened, [['http://127.0.0.1:43880/?rk=abc', '_blank', 'noopener,noreferrer']]);
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});
