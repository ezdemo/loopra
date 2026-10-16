import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

// The requirement board mirrors legacy `RequirementBoard.vue`: a four-column
// board plus comment / execution-log tabs whose split rules must stay identical.
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
async function sourceUrl(name, dependencies = {}) {
  const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
  for (const [specifier, url] of Object.entries(dependencies)) {
    outputText = outputText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
  }
  return dataUrl(outputText);
}

const chatStub = dataUrl('export const groupToolBlocks = blocks => blocks; export const splitAssistantBlocks = blocks => ({ process: [], final: blocks }); export const splitUserContext = text => ({ context: "", text });');
const historyStub = dataUrl(`
// Minimal stand-in for backend.historyMessages: fold assistant turns into blocks.
export function historyMessages(raw) {
  const messages = [];
  let current;
  for (const [index, entry] of raw.entries()) {
    if (entry.role !== 'assistant') continue;
    if (!current) { current = { id: 'history-' + index, role: 'assistant', text: '', blocks: [], time: '' }; messages.push(current); }
    if (entry.reasoning_content) current.blocks.push({ id: 'r' + index, type: 'reasoning', content: entry.reasoning_content });
    for (const call of entry.tool_calls || []) current.blocks.push({ id: 't' + index, type: 'tool_call', name: call.function?.name || call.name, status: '成功', result: 'ok' });
    if (entry.content) current.blocks.push({ id: 'c' + index, type: 'content', content: entry.content });
  }
  return messages;
}
`);

const requirements = await import(await sourceUrl('requirements.ts', {
  './chat': chatStub,
  './backend': historyStub,
}));

const { requirementComments, requirementCommentCount, requirementLogCount, requirementLogMessages,
  normalizeRequirementComment, requirementModelOptions, splitRequirementModel,
  requirementScheduleDescription, formatRequirementTime, formatRequirementRelative,
  requirementStatusLabel, requirementPriorityLabel, isScheduledRequirement, REQUIREMENT_COLUMNS } = requirements;

test('the board exposes the four legacy columns in order', () => {
  assert.deepEqual(REQUIREMENT_COLUMNS.map(column => column.key), ['todo', 'doing', 'done', 'failed']);
  assert.equal(requirementStatusLabel('doing'), '执行中');
  assert.equal(requirementPriorityLabel('high'), '高');
});

test('comment tab pairs user comments with the following AI reply', () => {
  const messages = [
    { role: 'user', content: '请支持导出', timestamp: 1000 },
    { role: 'assistant', content: '收到，我来实现。', timestamp: 2000 },
    { role: 'user', content: '补充：导出 CSV', timestamp: 3000 },
    { role: 'assistant', content: '好的。', timestamp: 4000 },
  ];
  const comments = requirementComments(messages);
  assert.deepEqual(comments.map(item => item.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(comments[1].content, '收到，我来实现。');
  assert.equal(requirementCommentCount(messages), 2);
});

test('comment tab hides internal prompts and web-hidden messages but keeps the reply', () => {
  const messages = [
    { role: 'user', content: '请执行需求。执行期间用户评论会作为消息进入本会话', timestamp: 1000 },
    { role: 'assistant', content: '开始执行。', timestamp: 2000 },
    { role: 'user', content: '内部指令', timestamp: 3000, web_hidden: true },
    { role: 'assistant', content: '已处理评论。', timestamp: 4000 },
  ];
  const comments = requirementComments(messages);
  assert.deepEqual(comments.map(item => item.role), ['assistant', 'assistant']);
  assert.equal(requirementCommentCount(messages), 0);
});

test('finish summaries show standalone, and the log count only counts assistant text', () => {
  const messages = [
    { role: 'user', content: '跑一下', timestamp: 1000 },
    { role: 'assistant', content: '✅ 已完成 1) 构建 2) 测试', timestamp: 2000 },
    { role: 'assistant', content: '中间过程', timestamp: 2500 },
    { role: 'tool', content: 'tool result', tool_call_id: 'x', timestamp: 2600 },
  ];
  const comments = requirementComments(messages);
  // The finish summary answers the pending comment, so the later process-only
  // assistant message is not duplicated into the comment list.
  assert.deepEqual(comments.map(item => item.role), ['user', 'assistant']);
  assert.equal(comments[1].content, '✅ 已完成 1) 构建 2) 测试');
  const standalone = requirementComments([{ role: 'assistant', content: '❌ 执行失败：缺少依赖', timestamp: 500 }]);
  assert.deepEqual(standalone.map(item => item.content), ['❌ 执行失败：缺少依赖']);
  assert.equal(requirementLogCount(messages), 2);
});

test('log tab rebuilds assistant turns from the stored message stream', () => {
  const logs = requirementLogMessages([
    { role: 'user', content: '开始', timestamp: 1000 },
    { role: 'assistant', content: '执行中', reasoning_content: '先看代码', tool_calls: [{ id: 'a', function: { name: 'read', arguments: '{}' } }], timestamp: 2000 },
    { role: 'tool', content: 'file body', tool_call_id: 'a', timestamp: 2100 },
    { role: 'assistant', content: '✅ 完成', timestamp: 3000 },
  ]);
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0].blocks.map(block => block.type), ['reasoning', 'tool_call', 'content', 'content']);
});

test('finish summaries normalize packed numbered items into markdown bullets', () => {
  assert.equal(normalizeRequirementComment('普通评论 1) 不动'), '普通评论 1) 不动');
  const normalized = normalizeRequirementComment('✅ 已完成：1) 构建 2) 测试');
  assert.match(normalized, /\n\n- 构建/);
  assert.match(normalized, /\n\n- 测试/);
});

test('model selection maps to channel::model and back', () => {
  const options = requirementModelOptions([
    { id: 'ch1', name: '主力', models: [{ name: 'm1' }, { name: 'm2' }] },
    { id: 'ch2', models: [{ name: 'm3' }] },
  ]);
  assert.deepEqual(options, [
    { value: 'ch1::m1', label: 'm1 (主力)' },
    { value: 'ch1::m2', label: 'm2 (主力)' },
    { value: 'ch2::m3', label: 'm3 (ch2)' },
  ]);
  assert.deepEqual(splitRequirementModel('ch1::m2'), { modelChannelId: 'ch1', model: 'm2' });
  assert.deepEqual(splitRequirementModel(''), { modelChannelId: null, model: null });
});

test('scheduling helpers describe immediate and timed requirements', () => {
  assert.equal(isScheduledRequirement({ id: 'a', title: 't', scheduleMode: 'immediate' }), false);
  assert.equal(isScheduledRequirement({ id: 'a', title: 't', scheduleMode: 'scheduled', scheduledAt: 123 }), true);
  assert.match(requirementScheduleDescription({ id: 'a', title: 't' }), /立即执行/);
  assert.match(requirementScheduleDescription({ id: 'a', title: 't', scheduleMode: 'scheduled', scheduledAt: Date.now() }), /定时执行/);
});

test('time formatting matches the legacy today / yesterday / date rules', () => {
  const now = Date.now();
  assert.match(formatRequirementTime(now), /^今天 \d{2}:\d{2}$/);
  assert.match(formatRequirementTime(now - 24 * 3600 * 1000), /^(昨天 \d{2}:\d{2}|\d+\/\d+ \d{2}:\d{2})$/);
  assert.equal(formatRequirementTime(0), '');
  assert.equal(formatRequirementRelative(now), '刚刚');
  assert.equal(formatRequirementRelative(now - 5 * 60 * 1000), '5 分钟前');
  assert.equal(formatRequirementRelative(now - 3 * 3600 * 1000), '3 小时前');
  assert.equal(formatRequirementRelative(now - 2 * 24 * 3600 * 1000), '2 天前');
  assert.match(formatRequirementRelative(now - 10 * 24 * 3600 * 1000), /^\d+月\d+日$/);
});
