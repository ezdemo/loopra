import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/dirty-diff.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { parseDirtyDiff } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('separates individual modifications within one context hunk', () => {
  assert.deepEqual(parseDirtyDiff('@@ -10,5 +10,5 @@\n a\n-old one\n+new one\n b\n-old two\n+new two\n c'), [
    { type: 'modified', startLine: 11, endLine: 11, afterLine: 10, originalStartLine: 11, originalLines: ['old one'] },
    { type: 'modified', startLine: 13, endLine: 13, afterLine: 12, originalStartLine: 13, originalLines: ['old two'] },
  ]);
});

test('anchors deletions at the start, middle and end of the current file', () => {
  assert.deepEqual(parseDirtyDiff('@@ -1,2 +1 @@\n-first\n keep')[0],
    { type: 'deleted', startLine: 1, endLine: 1, afterLine: 0, originalStartLine: 1, originalLines: ['first'] });
  assert.deepEqual(parseDirtyDiff('@@ -4,3 +4,2 @@\n before\n-removed\n after')[0],
    { type: 'deleted', startLine: 4, endLine: 4, afterLine: 4, originalStartLine: 5, originalLines: ['removed'] });
  assert.deepEqual(parseDirtyDiff('@@ -8,2 +8 @@\n keep\n-last')[0],
    { type: 'deleted', startLine: 8, endLine: 8, afterLine: 8, originalStartLine: 9, originalLines: ['last'] });
});

test('new files and complete deletions use a valid first-line gutter anchor', () => {
  assert.deepEqual(parseDirtyDiff('@@ -0,0 +1,2 @@\n+first\n+second')[0],
    { type: 'added', startLine: 1, endLine: 2, afterLine: 0, originalStartLine: 1, originalLines: [] });
  assert.deepEqual(parseDirtyDiff('@@ -1,2 +0,0 @@\n-first\n-second')[0],
    { type: 'deleted', startLine: 1, endLine: 1, afterLine: 0, originalStartLine: 1, originalLines: ['first', 'second'] });
});

test('handles CRLF, no-final-newline markers and header-like code inside a hunk', () => {
  const changes = parseDirtyDiff('diff --git a/a b/a\r\n--- a/a\r\n+++ b/a\r\n@@ -1 +1 @@\r\n--- old\r\n\\ No newline at end of file\r\n+++ new\r\n\\ No newline at end of file');
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].originalLines, ['-- old']);
  assert.equal(changes[0].type, 'modified');
});

test('retains complete blocks and drops the incomplete tail of a truncated patch', () => {
  const changes = parseDirtyDiff('@@ -1,5 +1,5 @@\n-old\n+new\n context\n-incomplete\n[diff truncated]');
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0].originalLines, ['old']);
});

test('unchanged text and binary file notices do not produce Git markers', () => {
  for (const patch of [undefined, '', 'plain file content', 'Binary files a/image.png and b/image.png differ']) {
    assert.deepEqual(parseDirtyDiff(patch), []);
  }
});
