import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

// Sub-agent replay is a pure event -> block rebuild (legacy subAgentBlocks.js),
// so assert the accumulation semantics plus the endpoint helpers.
const source = await readFile(new URL('../src/sub-sessions.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const module = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
const { subSessionBlocks, subSessionsPath, subSessionEventsPath, subSessionChatPath, subSessionLabel, subStatusLabel, formatSubTime } = module;

test('endpoint helpers scope every call to the parent session', () => {
  assert.equal(subSessionsPath('a b', 's/1'), '/sub-sessions?workspaceHash=a+b&sessionName=s%2F1');
  assert.equal(subSessionEventsPath('sub-1', 'h', 's'), '/sub-sessions/sub-1/events?workspaceHash=h&sessionName=s');
  assert.equal(subSessionChatPath('sub/2', 'h', 's'), '/sub-sessions/sub%2F2/chat?workspaceHash=h&sessionName=s');
});

test('labels and statuses follow the legacy mapping', () => {
  assert.equal(subSessionLabel({ subSessionId: 'x', name: '小瓜', title: '修复登录' }), '小瓜：修复登录');
  assert.equal(subSessionLabel({ subSessionId: 'x', task: '旧任务' }), '旧任务');
  assert.equal(subSessionLabel({ subSessionId: 'x' }), '子代理');
  assert.equal(subStatusLabel('running'), '运行中');
  assert.equal(subStatusLabel('aborted'), '已取消');
  assert.equal(subStatusLabel('error'), '失败');
  assert.equal(subStatusLabel('completed'), '已完成');
  assert.match(formatSubTime(Date.UTC(2026, 0, 2, 3, 4)), /^2026-01-0[12] \d{2}:0[34]$/);
  assert.equal(formatSubTime(0), '');
});

test('events rebuild content, reasoning, tool calls and results', () => {
  const { blocks, status } = subSessionBlocks([
    { type: 'sub_start', task: '修复登录' },
    { type: 'sub_reasoning', content: '先看代码' },
    { type: 'sub_reasoning', content: '再看日志' },
    { type: 'sub_tool_call', name: 'read', args: '{"file_path":"a.ts"}' },
    { type: 'sub_tool_result', name: 'read', result: 'file body' },
    { type: 'sub_content', content: '完成' },
    { type: 'sub_content', content: '修复' },
    { type: 'sub_end', status: 'completed' },
  ]);
  assert.deepEqual(blocks.map(block => block.type), ['reasoning', 'tool_call', 'content']);
  assert.equal(blocks[0].content, '先看代码再看日志');
  assert.deepEqual(blocks[1].args, { file_path: 'a.ts' });
  assert.equal(blocks[1].status, '成功');
  assert.equal(blocks[1].result, 'file body');
  assert.equal(blocks[2].content, '完成修复');
  assert.equal(status, 'completed');
});

test('an unmatched tool result still lands on the newest open call', () => {
  const { blocks } = subSessionBlocks([
    { type: 'sub_tool_call', name: 'grep', args: {} },
    { type: 'sub_tool_call', name: 'read', args: {} },
    { type: 'sub_tool_result', name: 'other', result: 'Error: boom' },
  ]);
  assert.equal(blocks[0].status, '执行中');
  assert.equal(blocks[1].status, '失败');
  assert.equal(blocks[1].result, 'Error: boom');
});

test('errors, choices, user turns and abort status are rendered', () => {
  const { blocks, status } = subSessionBlocks([
    { type: 'sub_user', content: '继续修' },
    { type: 'sub_choice', title: '允许执行', options: [{ title: '同意', value: '/agree' }], subId: 7 },
    { type: 'sub_error', error: '工具不可用' },
    { type: 'sub_end', status: 'aborted' },
  ]);
  assert.equal(blocks[0].content, '**你：** 继续修');
  assert.equal(blocks[1].type, 'choice');
  assert.equal(blocks[1].question, '子代理 允许执行');
  assert.deepEqual(blocks[1].options, [{ title: '同意', value: '/agree', description: undefined }]);
  assert.equal(blocks[1].subId, '7');
  assert.equal(blocks[2].content, '❌ 工具不可用');
  assert.equal(status, 'aborted');
});

test('empty content segments do not create blank blocks', () => {
  const { blocks } = subSessionBlocks([{ type: 'sub_content', content: '\n\n' }, { type: 'sub_reasoning', content: '  ' }]);
  assert.deepEqual(blocks, []);
});
