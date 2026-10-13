import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function sourceModule(name) {
  const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  return import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
}
const { sessionUpdatedLabel } = await sourceModule('search');
const { searchSettings } = await sourceModule('settings-search');
const { normalizeSettingsSection, settingsCategoryFor, settingsCategories } = await sourceModule('settings-navigation');

test('session dates use actual timestamps, including midnight and year boundaries', () => {
  const now = new Date(2026, 9, 12, 0, 1).getTime();
  assert.equal(sessionUpdatedLabel(now - 10_000, now), '刚刚');
  assert.equal(sessionUpdatedLabel(new Date(2026, 9, 11, 23, 59).getTime(), now), '昨天');
  assert.equal(sessionUpdatedLabel(new Date(2026, 9, 10).getTime(), now), '10/10');
  assert.equal(sessionUpdatedLabel(new Date(2025, 9, 10).getTime(), now), '2025/10/10');
  assert.equal(sessionUpdatedLabel(undefined, now), '');
  assert.equal(sessionUpdatedLabel(NaN, now), '');
  assert.equal(sessionUpdatedLabel(Infinity, now), '');
  const midday = new Date(2026, 9, 12, 12).getTime();
  assert.equal(sessionUpdatedLabel(midday - 5 * 60_000, midday), '5分钟前');
  assert.equal(sessionUpdatedLabel(midday - 2 * 3600_000, midday), '2小时前');
});

test('consolidated settings keep legacy entry points and merged controls reachable', () => {
  assert.equal(settingsCategories.length, 6);
  assert.equal(normalizeSettingsSection('账户'), '关于');
  assert.equal(normalizeSettingsSection('实验室'), '通用');
  assert.equal(normalizeSettingsSection('宠物'), '通用');
  assert.equal(normalizeSettingsSection('智能体'), '智能体与会话');
  assert.equal(settingsCategoryFor('MCP 服务器').name, '工具与集成');
  assert.equal(settingsCategoryFor('服务器').name, '连接与帮助');
  const sections = settingsCategories.flatMap(category => category.sections);
  assert.equal(new Set(sections.map(section => section.name)).size, sections.length);
  for (const section of sections) assert.equal(normalizeSettingsSection(section.name), section.name);
  assert.equal(searchSettings('宠物', sections).find(item => item.title === '宠物')?.category, '通用');
  assert.equal(searchSettings('实验室', sections).find(item => item.title === '界面动画')?.category, '通用');
});

test('settings search finds individual controls, aliases and category destinations', () => {
  const categories = [{ name: '通用', keywords: '外观 通知' }, { name: '模型供应商', keywords: 'API 密钥' }];
  assert.deepEqual(searchSettings(' 提示音 ', categories).map(item => [item.category, item.title]), [['通用', '通知提示音']]);
  assert.equal(searchSettings('SOUND', categories)[0].title, '通知提示音');
  assert.equal(searchSettings('缩放', categories)[0].title, '界面缩放');
  assert.equal(searchSettings('密钥', categories)[0].category, '模型供应商');
  assert.deepEqual(searchSettings('不存在的选项', categories), []);
  assert.deepEqual(searchSettings('   ', categories), []);
});
