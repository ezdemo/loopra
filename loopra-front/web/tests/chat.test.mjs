import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/chat.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { splitAssistantBlocks, groupToolBlocks, chainBlocks, collectPendingChoices, resolveChoiceBlock, unresolvedChoices, attachPendingChoices, formatTurnDuration, demoMessages } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

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

test('pending choices are collected in order, including sub-agent cards', () => {
  const first = { id: 'c1', type: 'choice', question: '第一个？', options: [{ title: 'A' }] };
  const second = { id: 'c2', type: 'choice', question: '第二个？', options: [{ title: 'B' }] };
  const nested = { id: 'c3', type: 'choice', question: '子代理？', options: [{ title: 'C' }], subId: '7' };
  const resolved = { id: 'c4', type: 'choice', question: '已答', options: [{ title: 'D' }], selected: 'D' };
  const sub = { id: 'sub', type: 'sub_agent', name: '子代理', status: '执行中', blocks: [nested] };
  const messages = [
    { id: 'u', role: 'user', text: '问题' },
    { id: 'a', role: 'assistant', text: '', blocks: [first, sub, resolved, second] },
  ];
  assert.deepEqual(collectPendingChoices(messages).map(choice => choice.id), ['c1', 'c3', 'c2']);
  assert.deepEqual(collectPendingChoices([{ id: 'u', role: 'user', text: 'x' }]), []);
});

test('resolving a choice marks it (even nested) so it drops out of the pending list', () => {
  const nested = { id: 'c3', type: 'choice', question: '子代理？', options: [{ title: 'C' }] };
  const blocks = [
    { id: 'c1', type: 'choice', question: '第一个？', options: [{ title: 'A' }] },
    { id: 'sub', type: 'sub_agent', name: '子代理', status: '执行中', blocks: [nested] },
  ];
  const next = resolveChoiceBlock(blocks, 'c3', '同意');
  assert.equal(next[1].blocks[0].selected, '同意');
  assert.equal(next[0].selected, undefined);
  const messages = [{ id: 'a', role: 'assistant', text: '', blocks: next }];
  assert.deepEqual(collectPendingChoices(messages).map(choice => choice.id), ['c1']);
});

test('unresolvedChoices keeps only the unanswered cards from a stream', () => {
  const pending = { id: 'c1', type: 'choice', question: '待选', options: [{ title: 'A' }] };
  const done = { id: 'c2', type: 'choice', question: '已选', options: [{ title: 'B' }], selected: 'B' };
  const tool = { id: 't', type: 'tool_call', name: 'read', status: '成功' };
  assert.deepEqual(unresolvedChoices([tool, pending, done]), [pending]);
  assert.deepEqual(unresolvedChoices(undefined), []);
});

test('attachPendingChoices reattaches a client-only card to the reloaded transcript', () => {
  const card = { id: 'c1', type: 'choice', question: '待选', options: [{ title: 'A' }] };
  const transcript = [
    { id: 'h0', role: 'user', text: '问题' },
    { id: 'h1', role: 'assistant', text: '', blocks: [{ id: 'h1-0', type: 'tool_call', name: 'ls', status: '成功' }] },
  ];
  const attached = attachPendingChoices(transcript, [card]);
  assert.equal(attached.length, 2);
  assert.deepEqual(attached[1].blocks.map(block => block.id), ['h1-0', 'c1']);
  // No-op without choices keeps the transcript identity.
  assert.equal(attachPendingChoices(transcript, []), transcript);
  // A trailing user message gets a fresh assistant bubble to hold the card.
  const trailingUser = attachPendingChoices([{ id: 'u', role: 'user', text: 'x' }], [card]);
  assert.equal(trailingUser.length, 2);
  assert.equal(trailingUser[1].role, 'assistant');
  assert.deepEqual(trailingUser[1].blocks, [card]);
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

test('consecutive thinking and tool steps fold into one reasoning chain', () => {
  const [chain, ...rest] = chainBlocks([reasoning, read, bash, reasoning, finish, read]);
  assert.equal(chain.type, 'chain');
  assert.deepEqual(chain.steps, [reasoning, read, bash, reasoning]);
  assert.deepEqual(rest, [finish, read]);
  // A single step is not worth a chain.
  assert.deepEqual(chainBlocks([read]), [read]);
  assert.deepEqual(chainBlocks([reasoning, finish]), [reasoning, finish]);
  assert.deepEqual(chainBlocks([]), []);
});

// "用时 0秒" reads like a broken clock, so a turn shorter than one second says "<1秒".
test('turn duration never renders as zero seconds', () => {
  assert.equal(formatTurnDuration(0), '<1秒');
  assert.equal(formatTurnDuration(999), '<1秒');
  assert.equal(formatTurnDuration(1000), '1秒');
  assert.equal(formatTurnDuration(59_900), '59秒');
  assert.equal(formatTurnDuration(60_000), '1分');
  assert.equal(formatTurnDuration(125_000), '2分5秒');
});
