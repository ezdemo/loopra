import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
const source = await readFile(new URL('../src/session-records.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { sessionRecords, filterSessionRecords, recordJson, recordArguments } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('parallel calls pair with their own results even when the results arrive in reverse order', () => {
  const messages = [
    { role: 'user', content: 'check files' },
    { role: 'assistant', content: 'Reading both files.', tool_calls: [{ id: 'a', function: { name: 'read', arguments: '{"path":"a.txt"}' } }, { id: 'b', name: 'read', arguments: { path: 'b.txt' } }] },
    { role: 'tool', tool_call_id: 'b', content: 'contents B' },
    { role: 'tool', tool_call_id: 'a', content: 'contents A' },
    { role: 'assistant', content: 'Done.' },
  ];
  const rows = sessionRecords(messages);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.filter(row => row.kind === 'tool').map(row => row.result), ['contents A', 'contents B']);
  assert.equal(rows[1].raw, messages[1]);
  assert.deepEqual(JSON.parse(recordJson(rows[2])), { call: messages[1].tool_calls[0], result: messages[3] });
});

test('orphan results remain in order and a missing result stays distinct from an empty result', () => {
  const rows = sessionRecords([
    { role: 'tool', tool_call_id: 'orphan', content: 'unpaired output' },
    { role: 'assistant', tool_calls: [{ id: 'a', name: 'empty' }, { id: 'b', name: 'missing' }] },
    { role: 'tool', tool_call_id: 'a', content: '' },
  ]);
  assert.equal(rows[0].result, 'unpaired output');
  assert.equal(rows[1].text, '（仅工具调用）');
  assert.equal(rows[2].result, '');
  assert.equal(rows[3].result, undefined);
});

test('hidden user messages become context, and camel-case tool fields are supported', () => {
  const rows = sessionRecords([
    { role: 'system', content: 'rules' },
    { role: 'user', web_hidden: true, content: 'internal instruction' },
    { role: 'user', contentParts: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,private' } }, { type: 'text', text: 'Look at this.' }] },
    { role: 'assistant', reasoningContent: 'check carefully', toolCalls: [{ id: 'c', name: 'read' }] },
    { role: 'tool', toolCallId: 'c', content: 'found' },
  ]);
  assert.deepEqual(rows.map(row => row.kind), ['context', 'context', 'input', 'model', 'tool']);
  assert.equal(rows[2].text, '[图片]\nLook at this.');
  assert.equal(rows[4].result, 'found');
});

test('search includes complete arguments, results and reasoning instead of only the preview', () => {
  const rows = sessionRecords([
    { role: 'assistant', reasoning_content: 'special reasoning', tool_calls: [{ id: 'a', name: 'bash', arguments: '{"command":"git status"}' }] },
    { role: 'tool', tool_call_id: 'a', content: 'BRANCH main' },
  ]);
  assert.equal(filterSessionRecords(rows, 'tool', 'branch MAIN').length, 1);
  assert.equal(filterSessionRecords(rows, 'all', 'git status').length, 1);
  assert.equal(filterSessionRecords(rows, 'model', 'special reasoning').length, 1);
  assert.equal(filterSessionRecords(rows, 'input', '').length, 0);
  assert.equal(recordArguments('not json'), 'not json');
  assert.equal(recordArguments('{"a":1}'), '{\n  "a": 1\n}');
});
