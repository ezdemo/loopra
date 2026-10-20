import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Legacy BlockRenderer.vue formatted tool params per tool name and exposed file
// tools (read/edit/write) as clickable filenames that open the original file.
const source = await readFile(new URL('../src/tool-params.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { toolParam, toolFileName } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('file tools expose the basename as a clickable path', () => {
  const param = toolParam('edit', { file_path: 'src/components/App.tsx' });
  assert.deepEqual(param, { text: 'App.tsx', title: 'src/components/App.tsx', filePath: 'src/components/App.tsx' });
  assert.equal(toolParam('write', { file_path: 'C:\\repo\\a\\b.ts' }).text, 'b.ts');
  // A non file tool keeps the plain text path without an open action.
  assert.equal(toolParam('read', { path: 'src' }).filePath, undefined);
  assert.equal(toolFileName(''), '');
});

test('bash commands and grep/glob paths truncate like the legacy helpers', () => {
  const command = 'x'.repeat(80);
  assert.deepEqual(toolParam('bash', { command }), { text: 'x'.repeat(57) + '...', title: command });
  assert.equal(toolParam('bash', { command: 'pnpm build' }).text, 'pnpm build');
  const path = 'y'.repeat(70);
  assert.deepEqual(toolParam('grep', { path }), { text: 'y'.repeat(47) + '...', title: path });
  assert.deepEqual(toolParam('glob', { path }), { text: 'y'.repeat(47) + '...', title: path });
  // ls shows the full path with no truncation.
  assert.deepEqual(toolParam('ls', { path }), { text: path });
});

test('ask_choice shows the question with an option count', () => {
  assert.deepEqual(toolParam('ask_choice', { question: '选哪个？', options: [{}, {}] }), { text: '选哪个？ (2 项)' });
  assert.deepEqual(toolParam('ask_choice', { question: '没有选项' }), { text: '没有选项' });
  const long = 'q'.repeat(60);
  assert.deepEqual(toolParam('ask_choice', { question: long, options: [{}] }), { text: 'q'.repeat(37) + '... (1 项)' });
});

test('unknown tools fall back to the generic param and empty is null', () => {
  assert.deepEqual(toolParam('custom', { pattern: 'foo' }), { text: 'foo' });
  assert.equal(toolParam('custom', { command: '' }), null);
  assert.equal(toolParam('custom', undefined), null);
});

test('the tool card renders the clickable file button', async () => {
  const blockRenderer = await readFile(new URL('../src/components/BlockRenderer.tsx', import.meta.url), 'utf8');
  assert.match(blockRenderer, /toolParam\(block\.name, block\.args\)/);
  assert.match(blockRenderer, /className="tool-file"/);
  // Tools inside a reasoning chain render through the same ToolBlock, and their
  // file path opens the original file rather than the Git diff.
  assert.match(blockRenderer, /<ToolBlock block=\{block\} onOpenFile=\{actions\.onOpenFile\} \/>/);
});
