import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/chat.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { splitAssistantBlocks, groupToolBlocks, demoMessages } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

const reasoning = { id: 'r', type: 'reasoning', content: '检查项目' };
const read = { id: 'read', type: 'tool_call', name: 'read', status: '成功' };
const bash = { id: 'bash', type: 'tool_call', name: 'bash', status: '执行中' };
const finish = { id: 'finish', type: 'tool_call', name: 'finish', status: '成功', result: '最终结果' };
const files = { id: 'files', type: 'file_changes', changes: [{ path: 'src/app.ts', additions: 2, deletions: 1 }] };

test('finish response stays visible and preceding reasoning/tools fold', () => {
  const blocks = [reasoning, read, { id: 'progress', type: 'content', content: '读取完成' }, finish, files];
  const original = structuredClone(blocks);
  const result = splitAssistantBlocks(blocks);
  assert.deepEqual(result.process, blocks.slice(0, 3));
  assert.deepEqual(result.final, [finish, files]);
  assert.deepEqual(blocks, original);
});

test('last nonempty content is the response boundary without finish', () => {
  const content = { id: 'body', type: 'content', content: '最终正文' };
  const whitespace = { id: 'empty', type: 'content', content: '  ' };
  assert.deepEqual(splitAssistantBlocks([reasoning, read, content, whitespace]), {
    process: [reasoning, read], final: [content, whitespace],
  });
});

test('unfinished streaming process remains visible until a response exists', () => {
  assert.deepEqual(splitAssistantBlocks([reasoning, bash]), { process: [], final: [reasoning, bash] });
  assert.deepEqual(splitAssistantBlocks([]), { process: [], final: [] });
});

test('file changes never disappear into the folded process', () => {
  assert.deepEqual(splitAssistantBlocks([reasoning, files, finish]), { process: [reasoning], final: [finish, files] });
});

test('choice and ask_choice are terminal response boundaries', () => {
  const choice = { id: 'choice', type: 'choice', question: '选哪个？', options: [] };
  const askChoice = { id: 'ask', type: 'tool_call', name: 'ask_choice', status: '成功' };
  for (const response of [choice, askChoice]) assert.deepEqual(splitAssistantBlocks([reasoning, read, response]), { process: [reasoning, read], final: [response] });
});

test('only adjacent ordinary tools merge; finish and reasoning separate groups', () => {
  const result = groupToolBlocks([read, bash, reasoning, read, finish, bash]);
  assert.equal(result[0].type, 'tool_group');
  assert.deepEqual(result[0].tools, [read, bash]);
  assert.deepEqual(result.slice(1), [reasoning, read, finish, bash]);
  assert.deepEqual(groupToolBlocks([finish]), [finish]);
  assert.deepEqual(groupToolBlocks([]), []);
});

test('demo turns keep their answer visible and block IDs are unique', () => {
  for (const messages of Object.values(demoMessages)) {
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      const ids = new Set();
      const visit = blocks => blocks.forEach(block => {
        assert.ok(!ids.has(block.id), 'duplicate block id: ' + block.id);
        ids.add(block.id);
        if (block.type === 'sub_agent') visit(block.blocks);
      });
      visit(message.blocks);
      assert.ok(splitAssistantBlocks(message.blocks).final.length > 0);
    }
  }
});
