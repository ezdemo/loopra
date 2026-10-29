import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

// Ported from legacy src/utils/fileIcons.js; keep the same kind/color contract so
// the React file tree can map each kind onto a lucide glyph.
const source = await readFile(new URL('../src/file-icons.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { fileIconFor, iconKind } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('well-known file names take priority over their extension', () => {
  assert.equal(fileIconFor('pom.xml').kind, 'maven');
  assert.equal(fileIconFor('package.json').kind, 'npm');
  // The legacy npm regex only matched package(-lock).json / npm-shrinkwrap.json.
  assert.equal(fileIconFor('pnpm-lock.yaml').kind, 'yaml');
  assert.equal(fileIconFor('build.gradle.kts').kind, 'gradle');
  assert.equal(fileIconFor('Dockerfile').kind, 'docker');
  assert.equal(fileIconFor('docker-compose.yml').kind, 'docker');
  assert.equal(fileIconFor('.gitignore').kind, 'git');
  assert.equal(fileIconFor('.env.local').kind, 'config');
});

test('extensions map to their kind and keep the legacy color', () => {
  assert.deepEqual(fileIconFor('app.tsx'), { kind: 'react', color: '#519aba', icon: 'codicon-symbol-class' });
  assert.deepEqual(fileIconFor('App.vue'), { kind: 'vue', color: '#8dc149', icon: 'codicon-symbol-color' });
  assert.equal(fileIconFor('Main.java').kind, 'java');
  assert.equal(fileIconFor('data.jsonc').kind, 'json');
  assert.equal(fileIconFor('style.scss').kind, 'sass');
  assert.equal(fileIconFor('deploy.ps1').kind, 'powershell');
  assert.equal(fileIconFor('avatar.webp').kind, 'image');
});

test('unknown or extension-less names fall back to the default icon', () => {
  assert.equal(iconKind('LICENSE'), 'default');
  assert.equal(iconKind('notes.xyz'), 'default');
  assert.equal(fileIconFor(undefined).kind, 'default');
});
