import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/last-workspace.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { LAST_WORKSPACE_KEY, preferredWorkspace, readLastWorkspace, writeLastWorkspace } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

function memory() {
  const values = new Map();
  return {
    getItem: key => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

const projects = [
  { hash: '__loopra_chat__', path: '', name: '纯聊天' },
  { hash: 'looprax', path: 'C:\\code\\looprax' },
  { hash: 'other', path: 'C:\\code\\other' },
];

test('a live selection wins over the remembered project and the configured path', () => {
  assert.equal(preferredWorkspace('other', projects, 'looprax', 'C:\\code\\looprax'), 'other');
});

test('the next visit restores the last selected project ahead of the configured default', () => {
  assert.equal(preferredWorkspace('', projects, 'other', 'C:\\code\\looprax'), 'other');
  assert.equal(preferredWorkspace('missing', projects, '__loopra_chat__', 'C:\\code\\looprax'), '__loopra_chat__');
});

test('a removed project falls back to the configured path, then the first entry', () => {
  assert.equal(preferredWorkspace('', projects, 'gone', 'C:\\code\\looprax'), 'looprax');
  assert.equal(preferredWorkspace('', projects, 'gone', 'C:\\missing'), '__loopra_chat__');
  assert.equal(preferredWorkspace('gone', [], 'other', 'C:\\code\\looprax'), 'gone');
});

test('the last choice is stored per browser and a blank choice does not erase it', () => {
  const storage = memory();
  assert.equal(readLastWorkspace(storage), '');
  writeLastWorkspace(storage, 'other');
  assert.equal(readLastWorkspace(storage), 'other');
  assert.equal(storage.getItem(LAST_WORKSPACE_KEY), JSON.stringify('other'));
  writeLastWorkspace(storage, '');
  assert.equal(readLastWorkspace(storage), 'other');
  storage.setItem(LAST_WORKSPACE_KEY, '{');
  assert.equal(readLastWorkspace(storage), '');
  storage.setItem(LAST_WORKSPACE_KEY, JSON.stringify(12));
  assert.equal(readLastWorkspace(storage), '');
});
