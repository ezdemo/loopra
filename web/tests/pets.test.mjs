import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const diffSource = await readFile(new URL('../src/diff.ts', import.meta.url), 'utf8');
const diffModuleUrl = 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(diffSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString('base64');
async function sourceModule(name) {
  const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  outputText = outputText.replaceAll("'./diff'", JSON.stringify(diffModuleUrl)).replaceAll('"./diff"', JSON.stringify(diffModuleUrl));
  return import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
}
const { LoopraClient } = await sourceModule('backend');
const { loadPets, petImageUrl, petScale, petActivity, petFrame, petReplyPreview, clampPetOffset, placePetPanel } = await sourceModule('pets');

test('reply previews include assistant text and nested answers, excluding reasoning and tool output', () => {
  assert.equal(petReplyPreview({ text: '', blocks: [{ type: 'reasoning', content: '内部思考' }, { type: 'tool_call', result: '工具输出' }, { type: 'sub_agent', blocks: [{ type: 'content', content: '已检查。' }] }, { type: 'content', content: '已完成。' }] }), '已检查。 已完成。');
  assert.equal(petReplyPreview({ text: '历史回复\n摘要' }), '历史回复 摘要');
  assert.equal(petReplyPreview({ text: '🐾'.repeat(160) }), '🐾'.repeat(150) + '…');
  assert.equal(petReplyPreview(), '');
});

test('saved offsets and operation panels remain reachable at viewport edges and after resize', () => {
  const origin = { x: 900, y: 700 }, size = { width: 80, height: 86 }, viewport = { width: 390, height: 480 };
  const offset = clampPetOffset({ x: 9999, y: -9999 }, origin, size, viewport);
  assert.equal(origin.x + offset.x + size.width, 382);
  assert.equal(origin.y + offset.y, 64);
  const panel = { width: 240, height: 180 };
  assert.deepEqual(placePetPanel({ x: 8, y: 64, ...size }, panel, viewport), { x: 8, y: 158 });
  assert.deepEqual(placePetPanel({ x: 302, y: 380, ...size }, panel, viewport), { x: 142, y: 192 });
});

test('pet images use the selected backend, including the development proxy and escaped names', () => {
  const previous = globalThis.window;
  try {
    globalThis.window = { location: { port: '3000', origin: 'http://127.0.0.1:3000' } };
    assert.equal(petImageUrl(new LoopraClient(), 'boba'), '/api/pets/boba/spritesheet');
    assert.equal(petImageUrl(new LoopraClient(), 'boba', 2), '/api/pets/boba/spritesheet?v=2');
    assert.equal(petImageUrl(new LoopraClient('http://127.0.0.1:3000'), 'boba'), '/api/pets/boba/spritesheet');
    assert.equal(petImageUrl(new LoopraClient('https://loopra.example'), '小猫 #1'), 'https://loopra.example/api/pets/%E5%B0%8F%E7%8C%AB%20%231/spritesheet');
  } finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
});

test('legacy size indexes survive migration; missing and invalid continuous scales do not hide pets', () => {
  assert.equal(petScale({}), 0.55);
  assert.equal(petScale({ scale: null, sizeIndex: 2 }), 0.75);
  assert.equal(petScale({ scale: NaN, sizeIndex: 0 }), 0.4);
  assert.equal(petScale({ scale: 0.001 }), 0.25);
  assert.equal(petScale({ scale: 5 }), 1.25);
  assert.equal(petScale({ sizeIndex: 999 }), 0.55);
});

test('pet animation follows agent activity and stops running after completion', () => {
  const tool = { id: 'tool', type: 'tool_call', name: 'read', status: '执行中' };
  assert.equal(petActivity(true), 'review');
  assert.equal(petActivity(true, [tool]), 'running');
  assert.equal(petActivity(false, [tool]), 'idle');
  const choice = { id: 'choice', type: 'choice', question: '继续？', options: [] };
  assert.equal(petActivity(false, [choice]), 'waiting');
  assert.equal(petActivity(false, [{ ...choice, selected: '继续' }]), 'idle');
});

test('idle animation wraps before unused atlas cells, preserving variable frame timing', () => {
  assert.equal(petFrame('idle', 279), 0);
  assert.equal(petFrame('idle', 280), 1);
  assert.equal(petFrame('idle', 1099), 5);
  assert.equal(petFrame('idle', 1100), 0);
  assert.equal(petFrame('running', 820), 0);
});

test('pets load from the legacy endpoints without inventing an active pet or writing sessions', async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const api = { async request(path, method, body, receivedSignal) {
    calls.push(path);
    assert.equal(method, 'GET'); assert.equal(body, undefined); assert.equal(receivedSignal, signal);
    return path === '/pets' ? [{ name: 'boba', hasSpritesheet: true }] : { active: false };
  } };
  assert.deepEqual(await loadPets(api, signal), { pets: [{ name: 'boba', hasSpritesheet: true }], active: null });
  assert.deepEqual(calls.sort(), ['/pets', '/pets/active']);
  const active = { active: true, name: 'boba', scale: 0.55 };
  assert.equal((await loadPets({ request: async path => path === '/pets' ? [] : active })).active, active);
  await assert.rejects(loadPets({ request: async () => { throw new Error('服务不可用'); } }), /服务不可用/);
});
