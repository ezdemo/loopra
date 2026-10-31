import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
async function compile(name) {
  const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
}
const navigation = dataUrl(await compile('settings-navigation'));
const source = (await compile('settings-plugin-menu')).replaceAll("'./settings-navigation'", JSON.stringify(navigation));
const { settingsWithPluginMenus, pluginSettingsCategory } = await import(dataUrl(source));

test('plugin page joins its requested category without changing the built-in pages', () => {
  const menus = [{ id: 'openapi', title: 'OpenAPI', category: '工具与集成', page: true }];
  const categories = settingsWithPluginMenus(menus);
  const sections = categories.find(category => category.name === '工具与集成').sections;
  assert.deepEqual(sections.map(section => section.label), ['工具', 'MCP', 'MCP 服务器', 'OpenAPI']);
  assert.equal(sections.at(-1).name, 'plugin:openapi');
  assert.equal(categories.flatMap(category => category.sections).filter(section => section.name === 'plugin:openapi').length, 1);
  assert.equal(pluginSettingsCategory(menus[0]), '工具与集成');
  assert.equal(settingsWithPluginMenus([]).flatMap(category => category.sections).some(section => section.name === 'plugin:openapi'), false);
});

test('grouped child pages retain distinct plugin routes and labels', () => {
  const categories = settingsWithPluginMenus([{ id: 'review', title: '回顾', category: '智能体', children: [{ id: 'focus', title: '关注点' }, { id: 'about', title: '说明' }] }]);
  const sections = categories.find(category => category.name === '智能体').sections.slice(-2);
  assert.deepEqual(sections.map(section => [section.name, section.label]), [['plugin:review:focus', '关注点'], ['plugin:review:about', '说明']]);
  assert.ok(sections.every(section => section.keywords.includes('回顾')));
});

test('unassigned and unknown categories remain standalone', () => {
  const menus = [{ id: 'legacy', title: 'Legacy' }, { id: 'future', title: 'Future', category: '不存在的分类' }];
  assert.equal(pluginSettingsCategory(menus[0]), undefined);
  assert.equal(pluginSettingsCategory(menus[1]), undefined);
  assert.deepEqual(settingsWithPluginMenus(menus), settingsWithPluginMenus([]));
});
