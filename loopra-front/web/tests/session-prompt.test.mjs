import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

// Regression: /agent/prompt returns { content, length }; rendering the object
// directly threw "Objects are not valid as a React child" and unmounted the app.
const source = await readFile(new URL('../src/session-prompt.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { promptText } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('promptText reads the backend payload content', () => {
  assert.equal(promptText({ content: 'core identity', length: 13 }), 'core identity');
});

test('promptText accepts a plain string payload', () => {
  assert.equal(promptText('legacy string'), 'legacy string');
});

test('promptText never returns a non-string renderable', () => {
  assert.equal(promptText(undefined), '');
  assert.equal(promptText(null), '');
  assert.equal(promptText({ length: 3 }), '');
  assert.equal(promptText({ content: 42 }), '');
});
