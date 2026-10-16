import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const diffSource = await readFile(new URL('../src/diff.ts', import.meta.url), 'utf8');
const diffModuleUrl = 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(diffSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString('base64');
const source = await readFile(new URL('../src/backend.ts', import.meta.url), 'utf8');
let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
outputText = outputText.replaceAll("'./diff'", JSON.stringify(diffModuleUrl)).replaceAll('"./diff"', JSON.stringify(diffModuleUrl));
const { SseParser, LoopraClient, applyEvent, historyMessages, hasEncryptedReasoning, remoteSession, configProviders, providerChannels, sessionRoute, permissionLabel, permissionValue } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('SSE preserves fragmented UTF-8, CRLF, comments and multiline frames', () => {
  const events = [];
  const parser = new SseParser(event => events.push(event));
  const bytes = new TextEncoder().encode(': heartbeat\r\nevent: content\r\ndata: "连接成功"\r\n\r\nevent: tool_call\ndata: {"name":"read",\ndata: "args":{"path":"a.ts"}}\n\nevent: done\ndata: {}\n\n');
  const decoder = new TextDecoder();
  for (const byte of bytes) parser.push(decoder.decode(new Uint8Array([byte]), { stream: true }));
  parser.push(decoder.decode(), true);
  assert.deepEqual(events, [{ type: 'content', content: '连接成功' }, { type: 'tool_call', name: 'read', args: { path: 'a.ts' } }, { type: 'done' }]);
});

test('stream keeps tool names, empty results, retry boundaries and final text distinct', () => {
  let message = { id: 'reply', role: 'assistant', text: '', blocks: [] };
  for (const event of [
    { type: 'tool_call', name: 'read', args: '{"path":"a"}' },
    { type: 'tool_call', name: 'search', args: {} },
    { type: 'tool_result', name: 'read', result: '' },
    { type: 'tool_result', name: 'search', result: 'found' },
    { type: 'reasoning', content: 'invalid' },
    { type: 'content', content: 'retry text' },
    { type: 'stream_reset' },
    { type: 'content', content: '正确' },
    { type: 'content', content: '回答' },
    { type: 'complete', content: '正确回答' },
  ]) message = applyEvent(message, event);
  assert.equal(message.text, '正确回答');
  assert.equal(message.blocks.length, 3);
  assert.equal(message.blocks[0].status, '成功');
  assert.equal(message.blocks[0].result, '');
  assert.equal(message.blocks[1].result, 'found');
  assert.deepEqual(message.blocks[0].args, { path: 'a' });
});

test('history merges assistant turns and tool results, preserving branch counts and hidden boundaries', () => {
  const history = historyMessages([
    { role: 'system', content: 'system' },
    { role: 'user', content: 'hello', timestamp: 1000 },
    { role: 'assistant', reasoning_content: 'thinking', tool_calls: [{ id: 'tc', function: { name: 'read', arguments: '{"path":"a"}' } }], timestamp: 1100 },
    { role: 'tool', tool_call_id: 'tc', content: 'file', tool_duration_ms: 20 },
    { role: 'assistant', content: 'done', timestamp: 2000 },
    { role: 'user', web_hidden: true, content: 'hidden' },
    { role: 'assistant', content: 'next', timestamp: 3000 },
  ]);
  assert.deepEqual(history.map(item => item.text), ['hello', 'done', 'next']);
  assert.equal(history[1].blocks[1].result, 'file');
  assert.equal(history[1].blocks[1].duration, '20ms');
  assert.equal(history[1].historyCount, 5);
  assert.equal(history[2].historyCount, 7);
  const toolTurn = historyMessages([{ role: 'assistant', tool_calls: [{ id: 'finish', function: { name: 'finish', arguments: {} } }] }, { role: 'tool', tool_call_id: 'finish', content: 'done' }]);
  assert.equal(toolTurn[0].historyCount, 2);
});

test('session IDs isolate duplicate session names across workspaces and encode routes', () => {
  const a = remoteSession({ name: '会话/a?', title: 'A', mtime: 1 }, { hash: 'a', name: 'same' });
  const b = remoteSession({ name: '会话/a?', title: 'B', mtime: 1 }, { hash: 'b', name: 'same' });
  assert.notEqual(a.id, b.id);
  assert.equal(a.kind, 'remote');
  assert.equal(sessionRoute(a, '/title'), '/sessions/%E4%BC%9A%E8%AF%9D%2Fa%3F/title?workspaceHash=a');
});

test('channel round trip preserves actual protocols, masked credentials and pricing', () => {
  const channels = [{ id: 'channel', name: 'Channel', apiProtocol: 'responses', specialCompatibility: 'opencode', baseUrl: 'http://example.test/v1', apiKey: 'abc****xyz', models: [{ name: 'model', contextTokens: 128000, maxTokens: 4096, imageInput: true, price: { input: 1, cache: 0.1, output: 2 } }] }];
  assert.deepEqual(providerChannels(configProviders({ modelChannels: channels })), channels);
  for (const mode of ['free', 'approval', 'auto']) assert.equal(permissionValue(permissionLabel(mode)), mode);
});

test('remote model discovery probes unsaved fields and resolves masked keys on the server', async () => {
  const original = globalThis.fetch;
  const client = new LoopraClient();
  const calls = [];
  try {
    globalThis.fetch = async (url, options) => {
      calls.push({ url, method: options.method, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ success: true, data: [' z-model ', 'a-model', 'z-model', ''] }));
    };
    const saved = { id: 'saved-channel', baseUrl: 'http://127.0.0.1:3425/v1/', apiKey: 'abcd****wxyz', type: 'responses', compatibility: 'opencode' };
    assert.deepEqual(await client.remoteModels(saved), ['a-model', 'z-model']);
    assert.deepEqual(calls[0], { url: 'http://127.0.0.1:4567/api/remote-models', method: 'POST', body: { channelId: 'saved-channel', baseUrl: 'http://127.0.0.1:3425/v1', apiProtocol: 'responses', specialCompatibility: 'opencode' } });
    await client.remoteModels({ ...saved, id: '', apiKey: 'test-only-key', type: 'chat_completions', compatibility: '' });
    assert.equal(calls[1].body.apiKey, 'test-only-key');
    assert.equal(calls[1].body.apiProtocol, 'chat_completions');
    assert.equal(calls[1].body.channelId, undefined);
    await client.remoteModels({ ...saved, apiKey: '' });
    assert.equal(calls[2].body.apiKey, undefined);
    await assert.rejects(client.remoteModels({ ...saved, id: '', apiKey: '' }), /请先填写 API 密钥/);
    await assert.rejects(client.remoteModels({ ...saved, baseUrl: '' }), /请先填写 API 地址/);
    await assert.rejects(client.remoteModels({ ...saved, baseUrl: 'file:///tmp/models' }), /HTTP/);
    assert.equal(calls.length, 3);
  } finally { globalThis.fetch = original; }
});

test('remote model discovery surfaces upstream failures, invalid results and cancellation', async () => {
  const original = globalThis.fetch;
  const client = new LoopraClient();
  const provider = { id: 'saved-channel', baseUrl: 'http://127.0.0.1:3425', apiKey: '', type: 'responses' };
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ success: false, error: '远程 API 返回错误 (401)' }));
    await assert.rejects(client.remoteModels(provider), /401/);
    globalThis.fetch = async () => new Response(JSON.stringify({ success: true, data: [{ id: 'unexpected' }] }));
    await assert.rejects(client.remoteModels(provider), /无效的模型列表/);
    globalThis.fetch = async () => new Response(JSON.stringify({ success: true, data: [] }));
    assert.deepEqual(await client.remoteModels(provider), []);
    const controller = new AbortController(); controller.abort();
    globalThis.fetch = async (_url, options) => { options.signal.throwIfAborted(); };
    await assert.rejects(client.remoteModels(provider, controller.signal), error => error.name === 'AbortError');
  } finally { globalThis.fetch = original; }
});

test('HTTP and SSE failures surface instead of inventing a mock response', async () => {
  const original = globalThis.fetch;
  const client = new LoopraClient('http://127.0.0.1:4567');
  const signal = new AbortController().signal;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ success: false, error: 'Agent 未就绪' }), { headers: { 'content-type': 'application/json' } });
    await assert.rejects(client.request('/config'), /Agent 未就绪/);
    await assert.rejects(client.stream({}, () => {}, signal), /Agent 未就绪/);
    globalThis.fetch = async () => new Response('event: content\ndata: "partial"\n\n', { headers: { 'content-type': 'text/event-stream' } });
    const received = [];
    await assert.rejects(client.stream({}, event => received.push(event), signal), /连接意外中断/);
    assert.equal(received[0].content, 'partial');
    globalThis.fetch = async () => new Response('event: error\ndata: {"error":"upstream unavailable"}\n\nevent: done\ndata: {}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    await assert.rejects(client.stream({}, () => {}, signal), /upstream unavailable/);
  } finally { globalThis.fetch = original; }
});

test('completion stops stream reading, and abort reaches fetch without a fallback', async () => {
  const original = globalThis.fetch;
  const client = new LoopraClient();
  try {
    globalThis.fetch = async () => new Response('event: content\ndata: "OK"\n\nevent: done\ndata: {}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    const events = [];
    await client.stream({}, event => events.push(event), new AbortController().signal);
    assert.equal(events[0].content, 'OK');
    const controller = new AbortController(); controller.abort();
    globalThis.fetch = async (_url, options) => { options.signal.throwIfAborted(); };
    await assert.rejects(client.stream({}, () => {}, controller.signal), error => error.name === 'AbortError');
  } finally { globalThis.fetch = original; }
});


test('Loopra terminal reply or approval accepts EOF while preserving trailing events and errors', async () => {
  const original = globalThis.fetch;
  const client = new LoopraClient();
  const signal = new AbortController().signal;
  try {
    const frame = 'event: complete\ndata: "Loopra 连接成功"\n\n';
    globalThis.fetch = async () => new Response(frame + 'event: usage\ndata: {"promptTokens":12}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    const events = [];
    await client.stream({}, event => events.push(event), signal);
    assert.deepEqual(events.map(event => event.type), ['complete', 'usage']);
    globalThis.fetch = async () => new Response('event: choice\ndata: {"title":"审批","options":[]}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    await client.stream({}, () => {}, signal);
    globalThis.fetch = async () => new Response(frame + 'event: error\ndata: {"error":"save failed"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    await assert.rejects(client.stream({}, () => {}, signal), /save failed/);
    globalThis.fetch = async () => new Response(frame + 'event: stream_reset\ndata: {}\n\nevent: content\ndata: "partial retry"\n\n', { headers: { 'content-type': 'text/event-stream' } });
    await assert.rejects(client.stream({}, () => {}, signal), /连接意外中断/);
  } finally { globalThis.fetch = original; }
});

test('file change accumulation preserves the reversible patches', () => {
  let message = { id: 'reply', role: 'assistant', text: '', blocks: [] };
  message = applyEvent(message, { type: 'file_changes', changes: [{ path: 'a.ts', additions: 2, deletions: 0, created: true, diff: 'patch1' }] });
  message = applyEvent(message, { type: 'file_changes', changes: [{ path: 'a.ts', additions: 1, deletions: 1, diff: 'patch2' }] });
  assert.deepEqual(message.blocks[0].changes, [{ path: 'a.ts', additions: 3, deletions: 1, created: true, diff: 'patch1\npatch2' }]);
});

test('sub-agent output stays isolated and approvals preserve backend IDs and values', () => {
  let message = { id: 'reply', role: 'assistant', text: '', blocks: [] };
  message = applyEvent(message, { type: 'sub_start', subId: 7, task: 'Explore' });
  message = applyEvent(message, { type: 'sub_content', subId: 7, token: 'result' });
  message = applyEvent(message, { type: 'sub_choice', subId: 7, options: [{ title: '同意', value: '/agree' }] });
  message = applyEvent(message, { type: 'sub_end', subId: 7 });
  assert.equal(message.blocks[0].name, 'Explore');
  assert.equal(message.blocks[0].blocks[0].content, 'result');
  assert.equal(message.blocks[0].status, '成功');
  assert.equal(message.blocks[1].subId, '7');
  assert.equal(message.blocks[1].options[0].value, '/agree');
  assert.equal(message.text, '');
});

test('encrypted reasoning opens a slot that visible deltas replace', () => {
  let message = { id: 'reply', role: 'assistant', text: '', blocks: [] };
  message = applyEvent(message, { type: 'reasoning_started' });
  assert.deepEqual(message.blocks, [{ id: 'reply-0', type: 'reasoning_started', content: '' }]);
  // Repeated starts collapse into one slot (legacy only pushes when the last
  // block is a different type).
  message = applyEvent(message, { type: 'reasoning_started' });
  assert.equal(message.blocks.length, 1);
  message = applyEvent(message, { type: 'reasoning', content: '可读思考' });
  assert.deepEqual(message.blocks, [{ id: 'reply-0', type: 'reasoning', content: '可读思考' }]);
  // A retry (stream_reset) also drops the empty encrypted slot.
  message = applyEvent(message, { type: 'reasoning_started' });
  message = applyEvent(message, { type: 'stream_reset' });
  assert.deepEqual(message.blocks, []);
});

test('history marks turns whose reasoning was encrypted', () => {
  assert.equal(hasEncryptedReasoning(undefined), false);
  assert.equal(hasEncryptedReasoning('not json'), false);
  assert.equal(hasEncryptedReasoning({ type: 'reasoning', encrypted_content: '' }), false);
  assert.equal(hasEncryptedReasoning({ type: 'reasoning', encrypted_content: 'gAAAA' }), true);
  assert.equal(hasEncryptedReasoning(JSON.stringify({ type: 'reasoning', encrypted_content: 'gAAAA' })), true);
  const messages = historyMessages([
    { role: 'user', content: '你好', timestamp: 1 },
    { role: 'assistant', content: '嗯', response_reasoning: { type: 'reasoning', encrypted_content: 'gAAAA' }, timestamp: 2 },
  ]);
  assert.deepEqual(messages[1].blocks.map(block => block.type), ['reasoning_started', 'content']);
  const plain = historyMessages([{ role: 'assistant', content: '嗯', response_reasoning: { type: 'reasoning', encrypted_content: '' } }]);
  assert.deepEqual(plain[0].blocks.map(block => block.type), ['content']);
});

test('successive full-file diffs of one path collapse into a single net diff', () => {
  const created = '@@ -1,0 +1,3 @@\n+a\n+b\n+c\n';
  const edited = '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n';
  const message = { id: 'm', role: 'assistant', text: '', blocks: [] };
  const first = applyEvent(message, { type: 'file_changes', changes: [{ path: 'x.txt', additions: 3, deletions: 0, created: true, diff: created }] });
  const merged = applyEvent(first, { type: 'file_changes', changes: [{ path: 'x.txt', additions: 1, deletions: 1, diff: edited }] });
  const [change] = merged.blocks.find(block => block.type === 'file_changes').changes;
  assert.equal(change.created, true);
  assert.equal(change.additions, 3);
  assert.equal(change.deletions, 0);
  assert.equal(change.diff, '@@ -1,0 +1,3 @@\n+a\n+B\n+c\n');
});
