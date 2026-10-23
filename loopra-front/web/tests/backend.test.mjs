import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const diffSource = await readFile(new URL('../src/diff.ts', import.meta.url), 'utf8');
const diffModuleUrl = 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(diffSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString('base64');
const source = await readFile(new URL('../src/backend.ts', import.meta.url), 'utf8');
let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
outputText = outputText.replaceAll("'./diff'", JSON.stringify(diffModuleUrl)).replaceAll('"./diff"', JSON.stringify(diffModuleUrl));
const { acpStopMessage, SseParser, StreamEventBuffer, LoopraClient, LoopraApiError, isSessionOccupiedError, applyEvent, historyMessages, hasEncryptedReasoning, remoteSession, configProviders, providerChannels, sessionRoute, permissionLabel, permissionValue, CHAT_WORKSPACE, isChatWorkspace, withChatWorkspace } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('model display names round-trip independently of API names and can be cleared', () => {
  const channels = [{ id: 'main', name: 'Main', baseUrl: '', apiKey: '', apiProtocol: 'responses', specialCompatibility: '', models: [{ name: 'namespace/long-api-model-id', displayName: 'Flash', contextTokens: 128000, maxTokens: 32768, imageInput: true }] }];
  const providers = configProviders({ modelChannels: channels });
  assert.deepEqual(providerChannels(providers), channels);
  providers[0].models[0].displayName = '  新名称  ';
  assert.equal(providerChannels(providers)[0].models[0].displayName, '新名称');
  assert.equal(providerChannels(providers)[0].models[0].name, 'namespace/long-api-model-id');
  providers[0].models[0].displayName = '  ';
  assert.equal('displayName' in providerChannels(providers)[0].models[0], false);
});

test('HTTP and SSE preserve occupation reasons while ordinary conflicts stay distinct', async () => {
  const original = globalThis.fetch;
  const client = new LoopraClient();
  const signal = new AbortController().signal;
  try {
    globalThis.fetch = async () => Response.json({ success: false, error: 'Busy in another app', reason: 'thread_active_writer' }, { status: 409 });
    await assert.rejects(client.request('/agent-engines/config'), error =>
      isSessionOccupiedError(error) && error.status === 409 && error.message === 'Busy in another app');
    await assert.rejects(client.stream({}, () => {}, signal), isSessionOccupiedError);
    globalThis.fetch = async () => new Response('event: error\ndata: {"error":"Busy","reason":"thread_active_writer"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    await assert.rejects(client.stream({}, () => {}, signal), isSessionOccupiedError);
    globalThis.fetch = async () => Response.json({ success: false, error: '会话已被占用' }, { status: 409 });
    await assert.rejects(client.request('/agent-engines/config'), error =>
      error instanceof LoopraApiError && !isSessionOccupiedError(error));
    assert.equal(isSessionOccupiedError(new Error('thread_active_writer')), false);
  } finally { globalThis.fetch = original; }
});

test('pure chat is a first-class workspace that never appears in project lists twice', () => {
  const projects = [{ hash: 'p1', name: 'Project', path: '/project' }, { ...CHAT_WORKSPACE }];
  const visible = withChatWorkspace(projects);
  assert.equal(visible[0].kind, 'chat');
  assert.equal(visible.filter(isChatWorkspace).length, 1);
  assert.equal(visible[1].kind, 'project');
});

test('ACP stop notices distinguish completion from cancellation and limits', () => {
  assert.equal(acpStopMessage('end_turn'), '');
  assert.equal(acpStopMessage(undefined), '');
  assert.match(acpStopMessage('cancelled'), /已停止/);
  assert.match(acpStopMessage('max_tokens'), /尚未完成/);
  assert.match(acpStopMessage('max_turn_requests'), /请求次数上限/);
  assert.match(acpStopMessage('refusal'), /拒绝/);
});

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

test('ACP child permissions keep their request identity and resolve in the parent conversation', () => {
  let message = { id: 'reply', role: 'assistant', text: '', blocks: [] };
  message = applyEvent(message, { type: 'sub_choice', subId: 'codex-child', permissionRequestId: 'child-request', title: 'Read', options: [{ title: 'Allow once', value: 'allow' }] });
  assert.equal(message.blocks[0].permissionRequestId, 'child-request');
  assert.equal(message.blocks[0].subId, 'codex-child');
  message = applyEvent(message, { type: 'permission_resolved', permissionRequestId: 'child-request', optionId: 'allow' });
  assert.equal(message.blocks[0].selected, 'Allow once');
});

test('history reload keeps API contentParts images and text instead of replacing the live bubble with an empty one', () => {
  const images = ['data:image/png;base64,first', 'data:image/png;base64,second'];
  const [message] = historyMessages([{ role: 'user', content: '', contentParts: [
    { type: 'image_url', imageUrl: { url: images[0] } },
    { type: 'text', text: '看看这两张图' },
    { type: 'image_url', image_url: { url: images[1] } },
  ], timestamp: 1000, snapshot_id: 'snapshot', rollback_id: 'rollback' }]);
  assert.equal(message.text, '看看这两张图');
  assert.deepEqual(message.images, images);
  assert.equal(message.snapshotId, 'snapshot');
  assert.equal(message.rollbackId, 'rollback');
  assert.equal(message.historyCount, 1);
});

test('image-only history survives both API and JSONL formats, including after serialization', () => {
  const image = 'data:image/png;base64,image-only';
  for (const raw of [
    { role: 'user', content: null, contentParts: [{ type: 'image_url', imageUrl: { url: image } }] },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: image } }] },
  ]) {
    const [message] = historyMessages(JSON.parse(JSON.stringify([raw])));
    assert.equal(message.text, '');
    assert.deepEqual(message.images, [image]);
  }
});

test('history keeps plain text when parts are empty and does not duplicate multimodal text', () => {
  const messages = historyMessages([
    { role: 'user', content: '普通文本', contentParts: [] },
    { role: 'user', content: '重复的摘要', contentParts: [{ type: 'text', text: '图片说明' }] },
    { role: 'user', contentParts: [{ type: 'text', text: '隐藏内容' }], web_hidden: true },
  ]);
  assert.deepEqual(messages.map(message => message.text), ['普通文本', '图片说明']);
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

test('tool output snapshots update running calls by ID and survive final results and history reload', () => {
  let message = { id: 'reply', role: 'assistant', text: '', blocks: [] };
  for (const toolCallId of ['read', 'shell']) message = applyEvent(message, { type: 'tool_call', toolCallId, name: 'Read', args: { path: toolCallId } });
  message = applyEvent(message, { type: 'tool_update', toolCallId: 'read', result: 'first\n' });
  message = applyEvent(message, { type: 'tool_update', toolCallId: 'shell', result: 'error\n' });
  message = applyEvent(message, { type: 'tool_update', toolCallId: 'read', result: 'first\nsecond\n' });
  assert.equal(message.blocks[0].result, 'first\nsecond\n');
  assert.equal(message.blocks[0].status, '执行中');
  assert.equal(message.blocks[1].result, 'error\n');
  assert.deepEqual(message.blocks[0].args, { path: 'read' });
  const saved = 'first\nsecond\n\nExit code: 0';
  message = applyEvent(message, { type: 'tool_result', toolCallId: 'read', result: saved, status: 'completed' });
  message = applyEvent(message, { type: 'tool_result', toolCallId: 'shell', result: 'error\n\nExit code: 7', status: 'failed' });
  assert.equal(message.blocks[0].result, saved, 'the final snapshot replaces, rather than appends to, live output');
  assert.equal(message.blocks[1].status, '失败');
  const [reloaded] = historyMessages([
    { role: 'assistant', tool_calls: [{ id: 'read', function: { name: 'Read', arguments: '{}' } }, { id: 'shell', function: { name: 'Run', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'read', content: saved },
    { role: 'tool', tool_call_id: 'shell', content: '[failed] error\n\nExit code: 7' },
  ]);
  assert.equal(reloaded.blocks[0].result, saved);
  assert.equal(reloaded.blocks[1].status, '失败', 'persisted external-agent failures retain their status');
});

test('live child tool output stays isolated from a parent call with the same ID', () => {
  let message = { id: 'reply', role: 'assistant', text: '', blocks: [] };
  message = applyEvent(message, { type: 'tool_call', toolCallId: 'read', name: 'Read' });
  message = applyEvent(message, { type: 'sub_start', subId: 'child', task: 'Explore' });
  message = applyEvent(message, { type: 'sub_tool_call', subId: 'child', toolCallId: 'read', name: 'Read' });
  message = applyEvent(message, { type: 'sub_tool_update', subId: 'child', toolCallId: 'read', result: 'child output' });
  assert.equal(message.blocks[0].result, undefined);
  assert.equal(message.blocks[1].blocks[0].result, 'child output');
  assert.equal(message.blocks[1].blocks[0].status, '执行中');
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

test('background sub-agent blocks do not split the parent Markdown message', () => {
  let message = { id: 'reply', role: 'assistant', text: '', blocks: [] };
  message = applyEvent(message, { type: 'content', content: '1. first\n' });
  // Claude flattens nested traffic onto the root stream, so the sub-agent block
  // appears in the middle of the parent's numbered list.
  message = applyEvent(message, { type: 'sub_start', subId: 'task-1', task: 'Explore' });
  message = applyEvent(message, { type: 'sub_content', subId: 'task-1', token: 'child' });
  message = applyEvent(message, { type: 'sub_end', subId: 'task-1', status: 'completed' });
  message = applyEvent(message, { type: 'content', content: '2. second' });
  const contents = message.blocks.filter(block => block.type === 'content');
  assert.equal(contents.length, 1);
  assert.equal(contents[0].content, '1. first\n2. second');
  assert.equal(message.text, '1. first\n2. second');
  assert.equal(message.blocks[1].type, 'sub_agent');
  assert.equal(message.blocks[1].status, '成功');

  message = applyEvent(message, { type: 'sub_end', subId: 'task-2', status: 'error' });
  assert.equal(message.blocks[2].status, '失败');
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


test('ACP tool IDs match concurrent identical tools and retain explicit status', () => {
  let message = { id: 'reply', role: 'assistant', text: '', blocks: [] };
  for (const event of [
    { type: 'tool_call', toolCallId: 'a', name: 'read', args: { path: 'a' } },
    { type: 'tool_call', toolCallId: 'b', name: 'read', args: { path: 'b' } },
    { type: 'tool_result', toolCallId: 'b', name: 'read', result: 'plain failure', status: 'failed' },
    { type: 'tool_result', toolCallId: 'a', name: 'read', result: 'Error is just file text', status: 'completed' },
    { type: 'tool_result', toolCallId: 'unknown', name: 'read', result: 'wrong', status: 'failed' },
  ]) message = applyEvent(message, event);
  assert.equal(message.blocks[0].result, 'Error is just file text');
  assert.equal(message.blocks[0].status, '成功');
  assert.equal(message.blocks[1].result, 'plain failure');
  assert.equal(message.blocks[1].status, '失败');
});

test('ACP permission keeps request ID and resolves on the original stream', () => {
  let message = applyEvent({ id: 'reply', role: 'assistant', text: '', blocks: [] }, {
    type: 'choice', permissionRequestId: 'request-1', title: 'write', options: [{ title: '允许一次', value: 'allow-once' }],
  });
  assert.equal(message.blocks[0].permissionRequestId, 'request-1');
  message = applyEvent(message, { type: 'permission_resolved', permissionRequestId: 'request-1', optionId: 'allow-once' });
  assert.equal(message.blocks[0].selected, '允许一次');
});

test('ACP approval event alone does not turn an interrupted stream into completion', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response('event: choice\ndata: {"permissionRequestId":"p","options":[]}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  try {
    await assert.rejects(new LoopraClient().stream({ message: 'hi' }, () => {}, new AbortController().signal), /连接意外中断/);
  } finally { globalThis.fetch = previous; }
});

test('ACP delayed tool arguments update one card while retaining its result', () => {
  let message = { id: 'reply', role: 'assistant', text: '', blocks: [] };
  for (const event of [
    { type: 'tool_call', toolCallId: 'write-1', name: 'Preparing file', args: {} },
    { type: 'tool_update', toolCallId: 'write-1', name: 'Write output.txt', args: '{"file_path":"output.txt"}' },
    { type: 'tool_result', toolCallId: 'write-1', name: 'Write output.txt', status: 'completed', result: 'written' },
    { type: 'tool_update', toolCallId: 'write-1', args: { file_path: 'output.txt', content: 'hello' } },
  ]) message = applyEvent(message, event);
  assert.equal(message.blocks.length, 1);
  assert.equal(message.blocks[0].name, 'Write output.txt');
  assert.deepEqual(message.blocks[0].args, { file_path: 'output.txt', content: 'hello' });
  assert.equal(message.blocks[0].status, '成功');
  assert.equal(message.blocks[0].result, 'written');
});

test('remote conversations preserve their Agent identity independently of model providers', () => {
  const session = remoteSession({ name: 'claude-chat', mtime: 1, messageCount: 2, agentId: 'claude-code' }, { hash: 'p', name: 'Project', path: '/project' });
  assert.equal(session.agentId, 'claude-code');
  assert.equal(session.id, 'p/claude-chat');
});

test('stream updates share untouched tools and never mutate previously rendered blocks', () => {
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  let message = { id: 'reply', role: 'assistant', text: '', blocks: [] };
  const events = [
    { type: 'tool_call', toolCallId: 'read', name: 'read', args: { path: 'large.txt' } },
    { type: 'tool_result', toolCallId: 'read', result: 'x'.repeat(100_000) },
    { type: 'content', content: 'first' }, { type: 'content', content: ' second' },
    { type: 'sub_start', subId: 'child', task: 'child' },
    { type: 'sub_tool_call', subId: 'child', toolCallId: 'child-tool', name: 'read' },
    { type: 'sub_tool_update', subId: 'child', toolCallId: 'child-tool', args: { path: 'a' } },
    { type: 'sub_tool_result', subId: 'child', toolCallId: 'child-tool', result: 'done' },
    { type: 'sub_content', subId: 'child', content: 'child text' }, { type: 'sub_end', subId: 'child' },
    { type: 'tool_update', toolCallId: 'read', name: 'updated' },
    { type: 'file_changes', changes: [{ path: 'a', additions: 1, deletions: 0, diff: 'first' }] },
    { type: 'file_changes', changes: [{ path: 'a', additions: 2, deletions: 0, diff: 'second' }] },
    { type: 'choice', permissionRequestId: 'approval', options: [{ title: 'Allow', value: 'yes' }] },
    { type: 'permission_resolved', permissionRequestId: 'approval', optionId: 'yes' },
    { type: 'stream_reset' },
  ];
  for (const event of events) {
    freeze(message); freeze(event);
    const previous = JSON.stringify(message);
    const next = applyEvent(message, event);
    assert.equal(JSON.stringify(message), previous);
    if (event.type === 'content') assert.equal(next.blocks[0], message.blocks[0], 'text leaves large tool output untouched');
    if (event.type.startsWith('sub_')) assert.equal(next.blocks[0], message.blocks[0], 'child events leave parent tools untouched');
    message = next;
  }
  assert.equal(message.text, 'first second');
  assert.equal(applyEvent(message, { type: 'usage' }), message, 'non-message metadata needs no new message');
});

test('buffered text preserves stream semantics, child ownership and control event order', () => {
  const events = [], failures = [];
  const buffer = new StreamEventBuffer(event => events.push(event), error => failures.push(error));
  const source = [
    { type: 'content', content: ' ' }, { type: 'content', content: 'first' },
    ...Array.from({ length: 100 }, () => ({ type: 'content', token: 'x' })),
    { type: 'token_speed', tokensPerSecond: 10 }, { type: 'token_speed', tokensPerSecond: 20 },
    { type: 'choice', permissionRequestId: 'approval', options: [{ title: 'Allow', value: 'yes' }] },
    { type: 'sub_content', subId: 'a', content: 'A' }, { type: 'sub_content', subId: 'b', content: 'B' },
    { type: 'sub_content', subId: 'a', content: '2' },
    { type: 'stream_reset' }, { type: 'reasoning', content: 'think' }, { type: 'content', content: 'final' },
    { type: 'complete' },
  ];
  for (const event of source) buffer.push(event);
  buffer.close();
  const seed = { id: 'reply', role: 'assistant', text: '', blocks: [] };
  assert.deepEqual(events.reduce(applyEvent, seed), source.reduce(applyEvent, seed));
  assert.equal(events.filter(event => event.type === 'token_speed').length, 1);
  assert.equal(events.find(event => event.type === 'token_speed').tokensPerSecond, 20);
  assert.equal(events.filter(event => event.type === 'content').length, 4);
  assert.deepEqual(failures, []);
});

test('first text and approvals are immediate, and cancellation discards pending deliveries', () => {
  const events = [];
  const buffer = new StreamEventBuffer(event => events.push(event), assert.fail);
  buffer.push({ type: 'content', content: 'first' });
  assert.equal(events.length, 1);
  buffer.push({ type: 'content', content: 'next' });
  assert.equal(events.length, 1);
  buffer.push({ type: 'elicitation', elicitationRequestId: 'question' });
  assert.deepEqual(events.map(event => event.type), ['content', 'content', 'elicitation']);
  buffer.push({ type: 'content', content: 'discard' });
  buffer.close(false); buffer.flush(); buffer.push({ type: 'content', content: 'late' });
  assert.equal(events.length, 3);
});

test('buffers deliver during an open stream and bound queued memory', async () => {
  let delivered;
  const ready = new Promise(resolve => { delivered = resolve; });
  const events = [];
  const buffer = new StreamEventBuffer(event => { events.push(event); if (event.content === 'later') delivered(); }, assert.fail, 1);
  try {
    buffer.push({ type: 'content', content: 'first' }); buffer.push({ type: 'content', content: 'later' });
    await ready;
    assert.equal(events.length, 2);
    buffer.push({ type: 'content', content: 'x'.repeat(32768) });
    assert.equal(events.length, 3, 'large bursts flush without retaining an unbounded queue');
  } finally { buffer.close(false); }
});

test('completion and upstream failure retain buffered partial text and close the timer', async () => {
  const original = globalThis.fetch;
  const frame = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  try {
    for (const terminal of ['done', 'error', 'eof']) {
      globalThis.fetch = async () => new Response(frame('content', { content: 'first' }) + frame('content', { content: ' buffered' }) + (terminal === 'eof' ? '' : frame(terminal, { error: 'failed' })), { headers: { 'content-type': 'text/event-stream' } });
      const events = [];
      const pending = new LoopraClient().stream({}, event => events.push(event), new AbortController().signal);
      if (terminal === 'done') await pending;
      else await assert.rejects(pending, terminal === 'error' ? /failed/ : /连接意外中断/);
      assert.equal(events.map(event => event.content || '').join(''), 'first buffered');
    }
  } finally { globalThis.fetch = original; }
});

test('an async buffered callback failure cancels the reader and rejects the owning stream', async () => {
  const original = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('event: content\ndata: "first"\n\nevent: content\ndata: "buffered"\n\n')); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } });
  try {
    await assert.rejects(new LoopraClient().stream({}, event => { if (event.content === 'buffered') throw new Error('render failed'); }, new AbortController().signal), /render failed/);
    assert.equal(cancelled, true);
  } finally { globalThis.fetch = original; }
});
