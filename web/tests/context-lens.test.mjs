import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { buildSnapshot, PIN_START, PIN_END } from '../../plugins/context-lens/snapshot.js';
import { llmRequest } from '../../plugins/context-lens/plugin.js';

const body = { model: 'fixture-model', messages: [
  { role: 'system', content: 'PROJECT RULES\n\n可用技能（先使用 skillread 读取完整规约）：\n- audit: inspect changes' },
  { role: 'user', content: 'Check the project' },
  { role: 'assistant', tool_calls: [{ id: 'read-1', function: { name: 'read', arguments: '{"path":"main.go"}' } }] },
  { role: 'tool', tool_call_id: 'read-1', content: '<script>malicious()</script>\n' + 'real tool output\n'.repeat(100) },
], tools: [{ type: 'function', function: { name: 'read', description: 'Read project files', parameters: { type: 'object' } } }] };
const snapshot = buildSnapshot({ app: 'project', sessionId: 'one', body, protocol: 'chat_completions', foldableCalls: ['read-1'] }, '1');

test('lens projects actual protocol fields, distinguishes skill listings and omits media payloads', () => {
  assert.equal(snapshot.blocks.filter(block => block.kind === 'result').length, 1);
  assert.ok(snapshot.blocks.some(block => block.title === '技能目录'));
  assert.ok(snapshot.blocks.find(block => block.kind === 'result').foldable);
  assert.equal(snapshot.groups.reduce((sum, group) => sum + group.tokens, 0), snapshot.tokens);
  const anthropic = buildSnapshot({ body: { model: 'claude', system: 'RULES', messages: [{ role: 'user', content: [
    { type: 'tool_result', tool_use_id: 't1', content: 'RESULT' }, { type: 'image', source: { type: 'base64', data: 'SECRET_BINARY' } },
  ] }] }, foldableCalls: ['t1'] }, '2');
  assert.ok(anthropic.media);
  assert.ok(anthropic.blocks.some(block => block.kind === 'result' && block.text === 'RESULT'));
  assert.ok(!JSON.stringify(anthropic).includes('SECRET_BINARY'));
  const responses = buildSnapshot({ body: { instructions: 'BASE' + PIN_START + 'PINNED' + PIN_END, input: [
    { type: 'function_call_output', call_id: 'r1', output: 'RESPONSE' }, { role: 'user', content: [{ type: 'input_text', text: 'question' }] },
  ] } }, '3');
  assert.ok(responses.blocks.some(block => block.kind === 'pin' && block.text === 'PINNED'));
  assert.ok(responses.blocks.some(block => block.kind === 'result' && block.text === 'RESPONSE'));
  const opaque = buildSnapshot({body:{input:[{type:'reasoning', summary:[], encrypted_content:'OPAQUE_PAYLOAD'}]}}, 'opaque');
  assert.equal(opaque.tokens, 0);
  assert.ok(!JSON.stringify(opaque).includes('OPAQUE_PAYLOAD'));
  const long = buildSnapshot({ body: { messages: [{ role: 'user', content: 'x'.repeat(100000) }] } }, '4');
  assert.equal(long.blocks[0].text.length, 96000);
  assert.equal(long.blocks[0].tokens, 25000);
  assert.ok(long.truncated);
});

const html = await readFile(new URL('../../plugins/context-lens/ui/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../../plugins/context-lens/ui/app.js', import.meta.url), 'utf8');
const page = html.replace('<script src="_loopra/bridge.js"></script>', '').replace('<script src="app.js"></script>', () => `<script>${script}</script>`);
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
function setup({ holdDetail = false } = {}) {
  let config = {}, release, context = { workspaceHash: 'project', sessionId: 'project/one' };
  const listeners = [], requests = [];
  const dom = new JSDOM(page, { runScripts: 'dangerously', beforeParse(window) {
    window.loopra = { ready: Promise.resolve(), context, onContext: fn => listeners.push(fn),
      config: { get: async () => structuredClone(config), set: async value => { config = JSON.parse(JSON.stringify(value)); return config; } },
      request: async (action, value) => {
        requests.push({ action, value });
        if (action === 'list') return { records: context.workspaceHash === 'project' ? [{ ...snapshot, blocks: undefined }] : [] };
        if (action === 'detail') { if (holdDetail) await new Promise(resolve => { release = resolve; }); return snapshot; }
        if (action === 'clear') return { ok: true };
        throw new Error(action);
      },
    };
  } });
  return { window: dom.window, document: dom.window.document, get config() { return config; }, requests,
    release: () => release?.(), change: next => { context = next; listeners.forEach(fn => fn(next)); }, close: () => dom.window.close() };
}

test('lens UI filters real blocks, inspects inert text, and saves scoped pin/fold controls', async () => {
  const ui = setup();
  try {
    await settle(); await settle();
    const d = ui.document;
    assert.equal(d.querySelector('#overview').hidden, false);
    assert.equal(d.querySelectorAll('.map-cell').length, snapshot.groups.length);
    d.querySelector('.map-cell[aria-label^="工具结果"]').click();
    assert.equal(d.querySelectorAll('.block').length, 1);
    d.querySelector('.block').click();
    assert.equal(d.querySelector('#inspector').hidden, false);
    assert.match(d.querySelector('#inspect-text').textContent, /malicious/);
    assert.equal(d.querySelector('#inspect-text script'), null);
    d.querySelector('#fold-block').click(); await settle();
    assert.deepEqual(ui.config.rules[0].folded, ['read-1']);
    assert.equal(ui.config.rules[0].key, '["project","one"]');
    d.querySelector('#back').click();
    d.querySelector('#pin-note').value = 'Remember the migration constraint';
    d.querySelector('#pin-note').dispatchEvent(new ui.window.Event('input'));
    d.querySelector('#pin-save').click(); await settle();
    const rewritten = llmRequest({ app: 'project', sessionId: 'one', system: 'BASE', config: ui.config });
    assert.match(rewritten.system, /Remember the migration constraint/);
    assert.deepEqual(rewritten.foldToolResults, ['read-1']);
    assert.deepEqual(llmRequest({ app: 'project', sessionId: 'two', system: 'BASE', config: ui.config }), {});
    assert.match(d.querySelector('#status').textContent, /下一次模型请求/);
  } finally { ui.close(); }
});

test('a late detail response cannot show the previous workspace snapshot', async () => {
  const ui = setup({ holdDetail: true });
  try {
    await settle();
    ui.change({ workspaceHash: 'other', sessionId: 'other/two' });
    await settle(); ui.release(); await settle();
    assert.equal(ui.document.querySelector('#overview').hidden, true);
    assert.equal(ui.document.querySelector('#empty').hidden, false);
    assert.equal(ui.document.querySelectorAll('.block').length, 0);
  } finally { ui.close(); }
});
