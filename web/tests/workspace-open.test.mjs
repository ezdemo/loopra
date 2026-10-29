import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/workspace-open.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { initialOpenWorkspace } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

const projects = [{ hash: 'loopra' }, { hash: 'looprax' }];

test('the first resolved project opens and later switches leave the open set alone', () => {
  const waiting = initialOpenWorkspace([], '', projects, false);
  assert.deepEqual(waiting, { expanded: [], applied: false });
  const opened = initialOpenWorkspace([], 'loopra', projects, false);
  assert.deepEqual(opened, { expanded: ['loopra'], applied: true });
  const switched = initialOpenWorkspace(opened.expanded, 'looprax', projects, opened.applied);
  assert.deepEqual(switched.expanded, ['loopra']);
  const collapsed = initialOpenWorkspace([], 'looprax', projects, true);
  assert.deepEqual(collapsed.expanded, []);
});

test('a project the user already opened is not duplicated', () => {
  assert.deepEqual(initialOpenWorkspace(['loopra', 'looprax'], 'loopra', projects, false), { expanded: ['loopra', 'looprax'], applied: true });
});
