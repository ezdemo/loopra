import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Tool rows carry a type glyph in the lead slot and a +added/-removed line
// count for successful write/edit calls; both are pure helpers on the args.
const source = await readFile(new URL('../src/tool-params.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { toolIcon, toolDiffStats } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('tool names map to their type glyph', () => {
  assert.equal(toolIcon('write'), 'pencil');
  assert.equal(toolIcon('edit'), 'pencil');
  assert.equal(toolIcon('bash'), 'terminal');
  assert.equal(toolIcon('read'), 'file');
  assert.equal(toolIcon('grep'), 'search');
  assert.equal(toolIcon('glob'), 'search');
  assert.equal(toolIcon('ls'), 'folder');
  assert.equal(toolIcon('web'), 'globe');
  assert.equal(toolIcon('sub_agent'), 'bot');
});

test('namespaced and variant names still resolve to their glyph', () => {
  assert.equal(toolIcon('Bash'), 'terminal');
  assert.equal(toolIcon('readfile'), 'file');
  assert.equal(toolIcon('read_image'), 'file');
  assert.equal(toolIcon('View Image shot.png'), 'file');
  assert.equal(toolIcon('multi_edit'), 'pencil');
  assert.equal(toolIcon('web_search'), 'globe');
  assert.equal(toolIcon('mcp__docs__fetch'), 'globe');
});

test('unknown tools keep the check mark', () => {
  assert.equal(toolIcon('tool_result'), 'check');
  assert.equal(toolIcon('finish'), 'check');
  assert.equal(toolIcon('ask_choice'), 'check');
  assert.equal(toolIcon('mcp__github__create_issue'), 'check');
  assert.equal(toolIcon(''), 'check');
});

test('write counts added lines from its content argument', () => {
  assert.deepEqual(toolDiffStats('write', { content: 'alpha\nbeta\n' }), { additions: 2, deletions: 0 });
  assert.deepEqual(toolDiffStats('write', { content: 'alpha' }), { additions: 1, deletions: 0 });
  assert.deepEqual(toolDiffStats('write', { content: '' }), { additions: 0, deletions: 0 });
  assert.equal(toolDiffStats('write', { path: 'a.ts' }), null);
});

test('edit sums old/new line counts across the edits list', () => {
  assert.deepEqual(toolDiffStats('edit', { edits: [{ old: 'a\nb', new: 'c' }] }), { additions: 1, deletions: 2 });
  assert.deepEqual(toolDiffStats('edit', { edits: [{ old: 'a', new: 'a\nb' }, { old: 'c', new: 'd' }] }), { additions: 3, deletions: 2 });
  assert.deepEqual(toolDiffStats('edit', { old_string: 'one', new_string: 'one\ntwo' }), { additions: 2, deletions: 1 });
  assert.equal(toolDiffStats('edit', { edits: [] }), null);
  assert.equal(toolDiffStats('edit', { edits: [{ old: 1 }] }), null);
  assert.equal(toolDiffStats('read', { path: 'x' }), null);
});
