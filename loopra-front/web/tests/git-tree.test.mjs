import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/git-tree.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { buildGitTree, gitTreeSelection, selectGitPaths, gitFileState } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
const file = (path, status = 'M', index = ' ', workTree = 'M') => ({ path, status, index, workTree });

test('nested changes form directory groups with accurate descendant counts and compact paths', () => {
  const tree = buildGitTree([file('loopra/src/A.java'), file('loopra/src/B.java'), file('intro/index.html'), file('README.md'), file('loopra/src/A.java')]);
  assert.deepEqual(tree.map(node => [node.name, node.paths.length]), [['intro', 1], ['loopra/src', 2], ['README.md', 1]]);
  assert.deepEqual(tree[1].children.map(node => node.name), ['A.java', 'B.java']);
  assert.deepEqual(tree[1].paths, ['loopra/src/A.java', 'loopra/src/B.java']);
});

test('folder selection preserves other groups and reports partial selection', () => {
  const paths = ['src/a.ts', 'src/b.ts'];
  assert.deepEqual(gitTreeSelection(paths, []), { checked: false, mixed: false });
  assert.deepEqual(gitTreeSelection(paths, ['src/a.ts']), { checked: false, mixed: true });
  const selected = selectGitPaths(['new.md', 'src/a.ts'], paths, true);
  assert.deepEqual(gitTreeSelection(paths, selected), { checked: true, mixed: false });
  assert.deepEqual(selectGitPaths(selected, paths, false), ['new.md']);
  assert.deepEqual(gitTreeSelection([], []), { checked: false, mixed: false });
});

test('files and directories sharing a change name both survive type changes', () => {
  const tree = buildGitTree([file('config', 'D'), file('config/app.json', 'U', '?', '?')]);
  assert.equal(tree.length, 2);
  assert.equal(tree[0].file, undefined);
  assert.equal(tree[1].file.path, 'config');
});

test('Windows separators normalize display paths while selections retain original paths', () => {
  const tree = buildGitTree([file('src\\中文 文件.ts')]);
  assert.equal(tree[0].path, 'src');
  assert.equal(tree[0].children[0].name, '中文 文件.ts');
  assert.deepEqual(tree[0].paths, ['src\\中文 文件.ts']);
});

test('untracked, staged and conflicting files have distinct actions and labels', () => {
  assert.equal(gitFileState(file('new.md', 'U', '?', '?')).text, '未跟踪');
  assert.equal(gitFileState(file('staged.ts', 'M', 'M', ' ')).staged, true);
  assert.equal(gitFileState(file('conflict.ts', 'U', 'U', 'U')).text, '存在冲突');
  assert.equal(gitFileState(file('conflict.ts', 'U', 'U', 'U')).staged, false);
});
