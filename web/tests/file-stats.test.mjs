import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Legacy ChatMessage.vue showed separate 修改/新增 file counts (edit vs write),
// whereas the first React cut labelled every change as 修改.
const source = await readFile(new URL('../src/file-stats.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { messageFileStats } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('file_changes split into edited and created by the created flag', () => {
  const stats = messageFileStats([
    { id: 'f', type: 'file_changes', changes: [
      { path: 'src/app.ts', additions: 3, deletions: 1 },
      { path: 'src/new.ts', additions: 12, deletions: 0, created: true },
      { path: 'src/app.ts', additions: 1, deletions: 0 },
    ] },
  ]);
  assert.deepEqual(stats.edited, ['src/app.ts']);
  assert.deepEqual(stats.created, ['src/new.ts']);
});

test('edit/write tool calls feed the legacy counters and finish is ignored', () => {
  const stats = messageFileStats([
    { id: 'e', type: 'tool_call', name: 'edit', status: '成功', args: { file_path: 'a/one.ts' } },
    { id: 'w', type: 'tool_call', name: 'write', status: '成功', args: { file_path: 'b/two.ts' } },
    { id: 'e2', type: 'tool_call', name: 'edit', status: '成功', args: { file_path: 'a/one.ts' } },
    { id: 'fin', type: 'tool_call', name: 'finish', status: '成功', args: { file_path: 'should/ignore.ts' } },
    { id: 'read', type: 'tool_call', name: 'read', status: '成功', args: { file_path: 'read/only.ts' } },
  ]);
  assert.deepEqual(stats.edited, ['a/one.ts']);
  assert.deepEqual(stats.created, ['b/two.ts']);
});

test('an empty turn reports no file stats', () => {
  assert.deepEqual(messageFileStats([]), { edited: [], created: [] });
  assert.deepEqual(messageFileStats(undefined), { edited: [], created: [] });
});

test('the assistant footer renders the split 修改/新增 counters', async () => {
  const conversation = await readFile(new URL('../src/components/Conversation.tsx', import.meta.url), 'utf8');
  assert.match(conversation, /messageFileStats\(blocks\)/);
  assert.match(conversation, /修改 \{stats\.edited\.length\} 文件/);
  assert.match(conversation, /新增 \{stats\.created\.length\} 文件/);
});
