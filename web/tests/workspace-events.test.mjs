import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import ts from 'typescript';

const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window; });
const source = await readFile(new URL('../src/workspace-events.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { notifyWorkspaceChanged, watchWorkspaceChanges } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('completed changes refresh only the matching project and stop after unmount', () => {
  let first = 0, second = 0;
  const stopFirst = watchWorkspaceChanges('first', () => first++);
  const stopSecond = watchWorkspaceChanges('second', () => second++);
  try {
    notifyWorkspaceChanged('first');
    assert.equal(first, 1); assert.equal(second, 0);
    notifyWorkspaceChanged(undefined);
    assert.equal(first, 1); assert.equal(second, 0);
    stopFirst(); notifyWorkspaceChanged('first'); notifyWorkspaceChanged('second');
    assert.equal(first, 1); assert.equal(second, 1);
  } finally { stopFirst(); stopSecond(); }
});
