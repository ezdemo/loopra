import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

// Legacy FileExplorer.vue decorated the file tree with git status letters and a
// colored ancestor-directory dot; the React panel had lost it. Cover the pure
// mapping here instead of a live backend.
const source = await readFile(new URL('../src/git-decorations.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { decorationFor, relativeGitPath, buildDecorations } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('decorationFor maps git status codes the way legacy did', () => {
  assert.deepEqual(decorationFor('U'), { label: 'U', kind: 'untracked' });
  assert.deepEqual(decorationFor('?'), { label: 'U', kind: 'untracked' });
  assert.deepEqual(decorationFor('a'), { label: 'A', kind: 'added' });
  assert.deepEqual(decorationFor('D'), { label: 'D', kind: 'deleted' });
  assert.deepEqual(decorationFor('M'), { label: 'M', kind: 'modified' });
  assert.deepEqual(decorationFor('R'), { label: 'R', kind: 'modified' });
  assert.deepEqual(decorationFor(undefined), { label: 'M', kind: 'modified' });
});

test('relativeGitPath normalizes backslashes and leading slashes', () => {
  assert.equal(relativeGitPath('src\\web\\app.ts'), 'src/web/app.ts');
  assert.equal(relativeGitPath('/src/app.ts'), 'src/app.ts');
  assert.equal(relativeGitPath(undefined), '');
});

test('buildDecorations is empty until the repo is initialized', () => {
  assert.deepEqual(buildDecorations(undefined), {});
  assert.deepEqual(buildDecorations({ initialized: false, changed: [{ path: 'a.ts', status: 'M' }] }), {});
});

test('buildDecorations keys files and propagates a tinting kind to ancestors', () => {
  const map = buildDecorations({
    initialized: true,
    changed: [{ path: 'src/web/app.ts', status: 'M' }, { path: 'docs/readme.md', status: 'D' }],
    untracked: [{ path: 'src/web/new.ts', status: '?' }],
  });
  assert.deepEqual(map['src/web/app.ts'], { label: 'M', kind: 'modified' });
  assert.deepEqual(map['src/web/new.ts'], { label: 'U', kind: 'untracked' });
  assert.deepEqual(map['docs/readme.md'], { label: 'D', kind: 'deleted' });
  // Ancestors only carry the kind (empty label), deepest first-wins.
  assert.deepEqual(map['src/web'], { label: '', kind: 'modified' });
  assert.deepEqual(map['src'], { label: '', kind: 'modified' });
  assert.deepEqual(map['docs'], { label: '', kind: 'deleted' });
});

test('buildDecorations keeps the first ancestor kind and skips empty paths', () => {
  const map = buildDecorations({ initialized: true, changed: [{ path: '', status: 'M' }, { path: 'a/b/c.ts', status: 'A' }] });
  assert.equal(map[''], undefined);
  assert.deepEqual(map['a/b/c.ts'], { label: 'A', kind: 'added' });
  assert.deepEqual(map['a'], { label: '', kind: 'added' });
  assert.deepEqual(map['a/b'], { label: '', kind: 'added' });
});
