import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

// chat-export mirrors legacy Chat.vue exportChat(): a plain-text transcript with
// 思考 / 内容 / 工具 lines and a --- separator between turns.
const source = await readFile(new URL('../src/chat-export.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { chatExportText } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('exports user turns and assistant blocks like the legacy transcript', () => {
  const text = chatExportText([
    { id: 'u1', role: 'user', text: '帮我读一下文件', time: '10:30' },
    { id: 'a1', role: 'assistant', text: '好的', time: '10:31', blocks: [
      { id: 'r', type: 'reasoning', content: '先看目录' },
      { id: 't', type: 'tool_call', name: 'read', status: '成功', args: { path: 'a.ts' } },
      { id: 'c', type: 'content', content: '文件内容如下' },
    ] },
  ]);
  assert.match(text, /\[10:30\] 用户:\n帮我读一下文件/);
  assert.match(text, /\[10:31\] 助手:/);
  assert.match(text, /思考: 先看目录/);
  assert.match(text, /工具 read: \{"path":"a\.ts"\}/);
  assert.match(text, /文件内容如下/);
  assert.ok(text.includes('\n---\n'), 'turns are separated by a --- divider');
});

test('falls back to message text for assistant turns without blocks', () => {
  const text = chatExportText([{ id: 'a2', role: 'assistant', text: '纯文本回复', time: '11:00' }]);
  assert.match(text, /\[11:00\] 助手:\n纯文本回复/);
});
