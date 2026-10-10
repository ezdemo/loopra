import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/composer.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { getModelCatalog, groupModels, composeMessage, estimateContext, appendPreset, defaultOptions } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
const providers = [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'magpie', name: 'magpie' }];
const models = getModelCatalog(providers);

test('same-name models keep distinct provider identities and search both fields', () => {
  const matches = groupModels(models, ' DEEPSEEK V4.1 ');
  assert.equal(matches.length, 2);
  assert.equal(new Set(matches.flatMap(group => group.models.map(model => model.id))).size, 2);
  assert.equal(groupModels(models, 'MAGPIE')[0].models.length, 3);
  assert.deepEqual(groupModels(models, 'missing-model'), []);
  assert.ok(!getModelCatalog([providers[0]]).some(model => model.providerId === 'magpie'));
  assert.deepEqual(getModelCatalog([{ id: 'custom', name: 'Custom' }]), []);
});

test('sent context is a stable folded snapshot, including the selected channel', () => {
  const options = { ...defaultOptions, plan: true, fast: true, effort: 'custom' };
  const context = { projects: ['runtime'], skills: ['代码审查'], files: ['notes.md'] };
  const text = composeMessage('审查代码', options, context, models.find(model => model.providerId === 'magpie'));
  options.plan = false;
  context.files.push('later.md');
  assert.match(text, /^```折叠块\n/);
  assert.match(text, /magpie \/ DeepSeek V4.1 Flash/);
  assert.match(text, /计划模式：开启/);
  assert.match(text, /推理强度：custom/);
  assert.match(text, /技能：代码审查/);
  assert.match(text, /仅文件名，未读取内容/);
  assert.ok(!text.includes('later.md'));
  assert.ok(text.endsWith('```\n审查代码'));
});

test('prompt presets append without losing existing drafts', () => {
  assert.equal(appendPreset('  ', '要求'), '要求');
  assert.equal(appendPreset('已有内容 \n', '要求'), '已有内容\n\n要求');
});

test('context estimates account for history/draft/chips and cap percentage', () => {
  const empty = { projects: [], skills: [], files: [] };
  const base = estimateContext([], '', empty);
  const usage = estimateContext(['你好', 'hello'], '继续', { ...empty, files: ['notes.md'] });
  assert.ok(usage.total > base.total);
  assert.equal(usage.parts.reduce((sum, part) => sum + part.tokens, 0), usage.total);
  assert.equal(estimateContext(['中'.repeat(130000)], '', empty).percent, 100);
  assert.ok(estimateContext([], '😀', empty).total > base.total);
});
