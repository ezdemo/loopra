import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

// Guard against settings drift: every section offered by the navigation must have
// a rendered branch in Settings.tsx, so a new/renamed section cannot silently
// become an empty page (the legacy Settings.vue kept nav and body in one file).
const navigationSource = await readFile(new URL('../src/settings-navigation.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(navigationSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { settingsCategories, normalizeSettingsSection, settingsCategoryFor } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
const settingsSource = await readFile(new URL('../src/components/Settings.tsx', import.meta.url), 'utf8');

const allSections = settingsCategories.flatMap(category => category.sections.map(section => ({ category: category.name, ...section })));

test('every navigation section renders a branch in Settings.tsx', () => {
  assert.ok(allSections.length >= 15, `expected the full settings surface, got ${allSections.length}`);
  for (const section of allSections) {
    assert.ok(settingsSource.includes(`'${section.name}'`), `Settings.tsx has no branch for section ${section.name}`);
  }
});

test('section names are unique and every section resolves to its own category', () => {
  const names = allSections.map(section => section.name);
  assert.equal(new Set(names).size, names.length, 'section names must be unique');
  for (const section of allSections) {
    assert.equal(normalizeSettingsSection(section.name), section.name);
    assert.equal(settingsCategoryFor(section.name).name, section.category);
  }
});

test('aliases used by deep links resolve to a real section', () => {
  // App.tsx opens settings with these legacy/alias names.
  assert.equal(normalizeSettingsSection('宠物'), '宠物');
  assert.equal(normalizeSettingsSection('实验室'), '通用');
  assert.equal(normalizeSettingsSection('账户'), '关于');
  // Category names collapse to their first section.
  assert.equal(normalizeSettingsSection('偏好设置'), '通用');
  assert.equal(settingsCategoryFor('通用').name, '偏好设置');
  assert.equal(settingsCategoryFor('宠物').name, '偏好设置');
  assert.equal(normalizeSettingsSection('智能体'), '智能体与会话');
  assert.equal(normalizeSettingsSection('工具与集成'), '工具');
  assert.equal(normalizeSettingsSection('工作区与数据'), '项目');
  assert.equal(normalizeSettingsSection('已归档的会话'), '项目');
  assert.equal(normalizeSettingsSection('已隐藏会话'), '项目');
  assert.equal(normalizeSettingsSection('连接与帮助'), '服务器');
  // Unknown names fall back to 通用 instead of rendering nothing.
  assert.equal(normalizeSettingsSection('不存在的分类'), '通用');
});
