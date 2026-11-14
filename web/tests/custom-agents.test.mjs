import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
async function transpile(name) {
  const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
  return ts.transpileModule(source, { compilerOptions }).outputText;
}

const diffModuleUrl = dataUrl(await transpile('diff.ts'));
const backendSource = (await transpile('backend.ts')).replaceAll("'./diff'", JSON.stringify(diffModuleUrl)).replaceAll('"./diff"', JSON.stringify(diffModuleUrl));
const backendUrl = dataUrl(backendSource);
const moduleSource = (await transpile('custom-agents.ts')).replaceAll("'./backend'", JSON.stringify(backendUrl)).replaceAll('"./backend"', JSON.stringify(backendUrl));
const backend = await import(backendUrl);
const { CHAT_WORKSPACE, withChatWorkspace } = backend;
const { isProjectWorkspace, isAgentWorkspace, isChatScoped, agentNameError, normalizeAgentName, agentPayload, draftFromAgent, toggleValue, pruneTools, pruneSkills, groupCatalogTools, catalogToolsFor, validDraftAgentId } = await import(dataUrl(moduleSource));

const projects = [
  { hash: 'looprax', name: 'looprax', path: '/code/looprax' },
  { hash: 'other', name: 'other', path: '/code/other' },
];
const agents = [
  { id: 'agent_aaaaaaaaaaaa', name: '审阅助手', instruction: '', projectHash: '', tools: null, skills: null, createdAt: 1, updatedAt: 1 },
  { id: 'agent_bbbbbbbbbbbb', name: '绑定助手', instruction: '审查代码', projectHash: 'looprax', tools: [], skills: [], createdAt: 2, updatedAt: 2 },
];

test('withChatWorkspace 排序：纯聊天、智能体、项目', () => {
  const visible = withChatWorkspace(projects, agents);
  assert.deepEqual(visible.map(item => item.hash), ['__loopra_chat__', 'agent_aaaaaaaaaaaa', 'agent_bbbbbbbbbbbb', 'looprax', 'other']);
  assert.equal(visible[1].kind, 'agent');
  assert.equal(visible[1].agent, agents[0]);
  assert.equal(visible[3].kind, 'project');
});

test('isProjectWorkspace 只认真实项目', () => {
  assert.equal(isProjectWorkspace(projects[0]), true);
  assert.equal(isProjectWorkspace({ kind: 'project' }), true);
  assert.equal(isProjectWorkspace({ name: '旧数据' }), true);
  assert.equal(isProjectWorkspace(CHAT_WORKSPACE), false);
  assert.equal(isProjectWorkspace(withChatWorkspace([], agents)[1]), false);
  assert.equal(isProjectWorkspace(undefined), true);
});

test('isAgentWorkspace 只认自定义智能体', () => {
  const visible = withChatWorkspace(projects, agents);
  assert.equal(isAgentWorkspace(visible[1]), true);
  assert.equal(isAgentWorkspace(visible[2]), true);
  assert.equal(isAgentWorkspace(visible[0]), false);
  assert.equal(isAgentWorkspace(visible[3]), false);
  assert.equal(isAgentWorkspace(undefined), false);
});

test('isChatScoped 覆盖纯聊天与未绑定智能体', () => {
  const visible = withChatWorkspace(projects, agents);
  assert.equal(isChatScoped(visible[0]), true);
  assert.equal(isChatScoped(visible[1]), true);
  assert.equal(isChatScoped(visible[2]), false);
  assert.equal(isChatScoped(visible[3]), false);
  assert.equal(isChatScoped({ hash: '__loopra_chat__' }), true);
  assert.equal(isChatScoped(undefined), false);
});

test('草稿往返保持 null 与数组的区分', () => {
  const draft = draftFromAgent(agents[0]);
  assert.equal(draft.toolsMode, 'default');
  assert.equal(draft.skillsMode, 'default');
  assert.deepEqual(agentPayload(draft), { name: '审阅助手', instruction: '', projectHash: '', tools: null, skills: null });
  const custom = draftFromAgent(agents[1]);
  assert.equal(custom.toolsMode, 'custom');
  assert.deepEqual(agentPayload(custom).tools, []);
  assert.deepEqual(agentPayload(custom).skills, []);
});

test('名称校验与后端一致', () => {
  assert.equal(normalizeAgentName('  助手  '), '助手');
  assert.equal(agentNameError(''), '请输入智能体名称');
  assert.equal(agentNameError('   '), '请输入智能体名称');
  assert.equal(agentNameError('审阅助手'), '');
  assert.equal(agentNameError('x'.repeat(40)), '');
  assert.match(agentNameError('x'.repeat(41)), /40/);
});

test('工具勾选切换与项目切换后的清理', () => {
  assert.deepEqual(toggleValue([], 'read', true), ['read']);
  assert.deepEqual(toggleValue(['read', 'write'], 'read', false), ['write']);
  assert.deepEqual(toggleValue(['read'], 'read', true), ['read']);
  const catalog = [
    { name: 'read', description: '', readOnly: true },
    { name: 'write', description: '', readOnly: false },
  ];
  assert.deepEqual(pruneTools(['read', 'bash', 'write'], catalog), ['read', 'write']);
  assert.deepEqual(pruneTools(['read', 'bash'], []), []);
});

test('技能勾选按 scope 清理', () => {
  const skills = [{ name: '技能', description: '', scope: '@global/a' }];
  assert.deepEqual(pruneSkills(['@global/a', '@global/b'], skills), ['@global/a']);
});

test('工具目录按名称排序并按只读/写入分组', () => {
  const { readOnly, write } = groupCatalogTools([
    { name: 'write', description: '', readOnly: false },
    { name: 'bash', description: '', readOnly: false },
    { name: 'read', description: '', readOnly: true },
  ]);
  assert.deepEqual(readOnly.map(tool => tool.name), ['read']);
  assert.deepEqual(write.map(tool => tool.name), ['bash', 'write']);
});

test('catalogToolsFor 按是否绑定项目选择目录', () => {
  const catalog = { chatTools: [{ name: 'a' }], projectTools: [{ name: 'b' }], skills: [] };
  assert.equal(catalogToolsFor(catalog, '')[0].name, 'a');
  assert.equal(catalogToolsFor(catalog, 'looprax')[0].name, 'b');
  assert.deepEqual(catalogToolsFor(undefined, ''), []);
});

test('草稿角色只在列表加载完成后按存在性校验', () => {
  assert.equal(validDraftAgentId('', agents, true), true);
  assert.equal(validDraftAgentId('agent_gone', [], false), true, '未加载不清理');
  assert.equal(validDraftAgentId('agent_gone', [], true), false, '加载完成后按列表判定');
  assert.equal(validDraftAgentId('agent_aaaaaaaaaaaa', agents, true), true);
});
