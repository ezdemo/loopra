import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Pure diff parsing behind the diff view: the legacy DiffViewer.vue paired
// removed and added lines, and UnifiedDiff turns those pairs into the single
// column of numbered +/- lines both the workspace pane and chat render.
const source = await readFile(new URL('../src/diff.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { parseDiffRows, diffHunkCount, wordDiff, diffFolds, foldContext, mergeFileDiffs, unifiedLines } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('pairs removed and added lines into replacements and keeps context', () => {
  const diff = [
    'diff --git a/a.txt b/a.txt',
    'index 111..222 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,3 +1,3 @@',
    ' keep',
    '-old',
    '+new',
  ].join('\n');
  assert.deepEqual(parseDiffRows(diff), [
    { type: 'context', left: 'keep', right: 'keep', leftLineNum: 1, rightLineNum: 1, hunkIndex: 0 },
    { type: 'replace', left: 'old', right: 'new', leftLineNum: 2, rightLineNum: 2, hunkIndex: 0 },
  ]);
});

test('numbers additions, removals and hunks independently', () => {
  const diff = [
    '@@ -10,1 +10,2 @@',
    '+a',
    '+b',
    '@@ -5,2 +5,0 @@',
    '-x',
    '-y',
  ].join('\n');
  const rows = parseDiffRows(diff);
  assert.deepEqual(rows, [
    { type: 'add', left: '', right: 'a', leftLineNum: null, rightLineNum: 10, hunkIndex: 0 },
    { type: 'add', left: '', right: 'b', leftLineNum: null, rightLineNum: 11, hunkIndex: 0 },
    { type: 'remove', left: 'x', right: '', leftLineNum: 5, rightLineNum: null, hunkIndex: 1 },
    { type: 'remove', left: 'y', right: '', leftLineNum: 6, rightLineNum: null, hunkIndex: 1 },
  ]);
  assert.equal(diffHunkCount(rows), 2);
});

test('represents an empty-file hunk and ignores metadata without hunks', () => {
  assert.deepEqual(parseDiffRows('@@ -0,0 +0,0 @@'), [
    { type: 'empty', left: '', right: '（空文件）', leftLineNum: null, rightLineNum: null, hunkIndex: 0 },
  ]);
  assert.deepEqual(parseDiffRows('diff --git a/a b/a\n--- a/a\n+++ b/a\n'), []);
  assert.deepEqual(parseDiffRows(undefined), []);
  assert.equal(diffHunkCount([]), 0);
});

test('the single column shows a replacement as the old line above the new one', () => {
  const rows = parseDiffRows('@@ -4,3 +4,4 @@\n keep\n-old\n+new\n+extra\n');
  assert.deepEqual(unifiedLines(rows), [
    [{ kind: 'context', lineNum: 4, text: 'keep', hunkIndex: 0, changed: false }],
    // Both halves of a pair carry the same hunk so navigation can find either.
    [
      { kind: 'remove', lineNum: 5, text: 'old', hunkIndex: 0, changed: true },
      { kind: 'add', lineNum: 5, text: 'new', hunkIndex: 0, changed: true },
    ],
    [{ kind: 'add', lineNum: 6, text: 'extra', hunkIndex: 0, changed: true }],
  ]);
});

test('the single column numbers each line from its own side of the file', () => {
  // A removal keeps the old file's number, an addition the new file's, and a
  // context line — present in both — is numbered from the new file.
  const rows = parseDiffRows('@@ -7,3 +9,3 @@\n gone\n-removed\n context1\n+added\n tail\n');
  assert.deepEqual(unifiedLines(rows).map(group => group.map(line => [line.kind, line.lineNum])), [
    [['context', 9]],
    [['remove', 8]],
    [['context', 10]],
    [['add', 11]],
    [['context', 12]],
  ]);
  assert.deepEqual(unifiedLines(parseDiffRows('@@ -0,0 +0,0 @@')), [[{ kind: 'empty', lineNum: null, text: '（空文件）', hunkIndex: 0, changed: false }]]);
  assert.deepEqual(unifiedLines([]), []);
});

test('wordDiff marks only the tokens that changed inside a replaced line', () => {
  const { left, right } = wordDiff('const total = price * 2;', 'const total = price * qty;');
  assert.deepEqual(left.filter(part => part.changed).map(part => part.text), ['2']);
  assert.deepEqual(right.filter(part => part.changed).map(part => part.text), ['qty']);
  assert.equal(left.map(part => part.text).join(''), 'const total = price * 2;');
  assert.equal(right.map(part => part.text).join(''), 'const total = price * qty;');
  // Identical lines have nothing to highlight; unrelated lines are fully changed.
  assert.equal(wordDiff('same', 'same').left.some(part => part.changed), false);
  assert.equal(wordDiff('abc', 'xyz').right.every(part => part.changed), true);
});

test('a hunk body keeps lines that begin with a file-header marker', () => {
  // Inside a hunk every line is content: `---` removed from a YAML file renders as
  // `----` and a `++` line added as `+++`. Skipping them drops real lines *and*
  // stops their numbering, so everything after them is numbered one line short.
  assert.deepEqual(parseDiffRows('@@ -1,3 +1,2 @@\n a\n----\n-c\n+b\n').map(row => [row.type, row.left, row.right, row.leftLineNum, row.rightLineNum]), [
    ['context', 'a', 'a', 1, 1],
    ['replace', '---', 'b', 2, 2],
    ['remove', 'c', '', 3, null],
  ]);
  assert.deepEqual(parseDiffRows('@@ -1,1 +1,3 @@\n a\n+---\n+++\n').map(row => [row.type, row.right, row.rightLineNum]), [
    ['context', 'a', 1],
    ['add', '---', 2],
    ['add', '++', 3],
  ]);
});

test('a patch holding two files keeps each file body out of the other', () => {
  // The second file's header block ends the first file's hunk body, and a `--`
  // comment or a `++` line inside either file is content all the same.
  const two = [
    'diff --git a/a.yml b/a.yml', '--- a/a.yml', '+++ b/a.yml', '@@ -1,1 +1,2 @@', ' key: 1', '+key2: 2',
    'diff --git a/b.sql b/b.sql', '--- a/b.sql', '+++ b/b.sql', '@@ -1,1 +1,1 @@', '--- note', '++ more',
  ].join('\n');
  assert.deepEqual(parseDiffRows(two).map(row => [row.type, row.left, row.right, row.leftLineNum, row.rightLineNum, row.hunkIndex]), [
    ['context', 'key: 1', 'key: 1', 1, 1, 0],
    ['add', '', 'key2: 2', null, 2, 0],
    ['replace', '-- note', '+ more', 1, 1, 1],
  ]);
});

test('a patch written with CRLF does not keep the carriage return in its lines', () => {
  const rows = parseDiffRows('@@ -1,2 +1,2 @@\r\n keep\r\n-old\r\n+new\r\n');
  assert.deepEqual(rows.map(row => [row.type, row.left, row.right]), [
    ['context', 'keep', 'keep'],
    ['replace', 'old', 'new'],
  ]);
});

test('diffFolds counts the unchanged lines hidden before each hunk', () => {
  const diff = ['@@ -10,2 +10,2 @@', ' a', '-b', '+c', '@@ -30,1 +30,1 @@', '-x', '+y'].join('\n');
  const rows = parseDiffRows(diff);
  const folds = diffFolds(rows);
  assert.equal(folds.get(0), 9);
  assert.equal(folds.get(rows.findIndex(row => row.hunkIndex === 1)), 18);
  assert.equal(diffFolds(parseDiffRows('@@ -1,1 +1,1 @@\n-a\n+b\n')).size, 0);
  // Folding folds the two hunks above into one block (nothing separates their
  // rows), yet the 18 lines between them are still reported: without this the
  // reader would see the second change directly under the first.
  const merged = foldContext(rows, 3);
  assert.equal(diffHunkCount(merged), 1);
  assert.deepEqual([...diffFolds(merged)], [[0, 9], [2, 18]]);
});

test('a hunk that opens with removals does not report a fold inside itself', () => {
  // Deleting the first lines of a file: the new-file cursor has not moved yet, so
  // measuring the gap from it would announce untouched lines between `-b` and ` c`
  // that are not there. Only the four lines above the group are really hidden.
  const rows = parseDiffRows('@@ -5,3 +5,3 @@\n-a\n-b\n c\n+x\n d\n');
  assert.deepEqual([...diffFolds(rows)], [[0, 4]]);
  // An addition-only group hides everything before it, on the same footing.
  assert.deepEqual([...diffFolds(parseDiffRows('@@ -10,0 +11,1 @@\n+a\n'))], [[0, 10]]);
});

test('foldContext keeps three rows around each change and numbers every block as its own hunk', () => {
  const lines = Array.from({ length: 30 }, (_, index) => ` line${index + 1}`);
  lines[4] = '-old5\n+new5';
  lines[24] = '-old25\n+new25';
  const rows = foldContext(parseDiffRows(`@@ -1,30 +1,30 @@\n${lines.join('\n')}\n`));
  assert.equal(diffHunkCount(rows), 2);
  assert.deepEqual(rows.map(row => row.leftLineNum), [2, 3, 4, 5, 6, 7, 8, 22, 23, 24, 25, 26, 27, 28]);
  assert.equal(diffFolds(rows).get(0), 1);
  assert.equal(diffFolds(rows).get(7), 13);
  // Without any change there is nothing to fold.
  const same = parseDiffRows('@@ -1,2 +1,2 @@\n a\n b\n');
  assert.equal(foldContext(same), same);
});

test('folding runs before the pairs expand, so a change run keeps three context lines a side', () => {
  // The change run is four replaced lines: four rows, eight rendered lines. Folding
  // is measured on the rows, so three context lines survive on each side of the run.
  const body = Array.from({ length: 11 }, (_, index) => index >= 3 && index <= 6 ? `-old${index}\n+new${index}` : ` line${index + 1}`);
  const rows = foldContext(parseDiffRows(`@@ -1,11 +1,11 @@\n${body.join('\n')}\n`), 3);
  const lines = unifiedLines(rows);
  // Three context lines on each side of the four-row change run survive folding.
  assert.deepEqual(lines.filter(group => group[0].kind === 'context').map(group => group[0].lineNum), [1, 2, 3, 8, 9, 10]);
  assert.deepEqual(lines.map(group => group[0].lineNum), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  // Only the paired rows expand, so the four changed lines render as eight.
  assert.deepEqual(lines.map(group => group.length), [1, 1, 1, 2, 2, 2, 2, 1, 1, 1]);
});

test('mergeFileDiffs turns two whole-file diffs into the net change', () => {
  const merged = mergeFileDiffs('@@ -1,0 +1,2 @@\n+a\n+b\n', '@@ -1,2 +1,3 @@\n a\n b\n+c\n');
  assert.deepEqual(merged, { diff: '@@ -1,0 +1,3 @@\n+a\n+b\n+c\n', additions: 3, deletions: 0 });
  // Partial hunks cannot be reconstructed, so the caller falls back to concatenating.
  assert.equal(mergeFileDiffs('@@ -10,1 +10,1 @@\n-a\n+b\n', '@@ -1,1 +1,1 @@\n-a\n+b\n'), null);
  assert.equal(mergeFileDiffs(undefined, '@@ -1,1 +1,1 @@\n-a\n+b\n'), null);
});
