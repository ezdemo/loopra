import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

async function sourceModule(name) {
  const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  return import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
}
const settings = await sourceModule('settings-data');
const composer = await sourceModule('composer');
const chat = await sourceModule('chat');
const defaults = () => structuredClone(settings.defaultAgentSettings);

test('custom provider models reach the picker; disabled channels stay out', () => {
  const provider = { id: 'custom', name: 'Demo', type: 'openai_responses', count: 1, models: [{ ...composer.newModel('custom-model'), contextTokens: 64000, maxTokens: 4096, imageInput: true }] };
  assert.equal(settings.validateProvider(provider), '');
  assert.equal(composer.getModelCatalog([provider])[0].id, 'custom:custom-model');
  assert.equal(composer.getModelCatalog([provider])[0].contextTokens, 64000);
  assert.equal(composer.getModelCatalog([provider])[0].imageInput, true);
  assert.deepEqual(composer.getModelCatalog([{ ...provider, enabled: false }]), []);
  assert.match(settings.validateProvider({ ...provider, models: [...provider.models, ...provider.models] }), /重复/);
  assert.match(settings.validateProvider({ ...provider, models: [{ ...provider.models[0], maxTokens: 128000 }] }), /不能超过/);
  assert.match(settings.validateProvider({ ...provider, baseUrl: 'file:///secret' }), /HTTP/);
});

test('available tools honor read-only mode and plugin switches', () => {
  const config = defaults();
  assert.ok(settings.availableTools(config, '完全自动').some(tool => tool.name === 'write'));
  assert.ok(settings.availableTools(config, '只读模式').every(tool => tool.readOnly));
  config.plugins.find(plugin => plugin.id === 'workspace').enabled = false;
  config.tools.find(tool => tool.name === 'bash').enabled = false;
  const names = settings.availableTools(config, '完全自动').map(tool => tool.name);
  for (const name of ['read', 'search', 'write', 'bash']) assert.ok(!names.includes(name));
});

test('runtime snapshots include prompt and selected tools but never integration credentials', () => {
  const config = defaults();
  config.integrations.push({ ...settings.newIntegration('openapi'), id: 'demo', name: 'Demo API', token: 'private-test-value', headers: '{"Authorization":"other-private-test"}' });
  const snapshot = settings.runtimeSnapshot(config, 'comfyui', composer.defaultOptions, false).join('\n');
  assert.ok(snapshot.includes(config.systemPrompt));
  assert.ok(snapshot.includes('Demo API'));
  assert.ok(!snapshot.includes('当前工作区'));
  assert.ok(!snapshot.includes('private-test'));
  assert.ok(settings.runtimeSnapshot(config, 'comfyui', composer.defaultOptions, true).join('\n').includes(config.projectPath));
});

test('integration validation distinguishes command transports and URL transports', () => {
  const mcp = { ...settings.newIntegration('mcp'), name: 'Example' };
  assert.match(settings.validateIntegration(mcp), /启动命令/);
  assert.equal(settings.validateIntegration({ ...mcp, command: 'demo-command' }), '');
  assert.match(settings.validateIntegration({ ...mcp, transport: 'SSE', url: 'javascript:alert(1)' }), /HTTP/);
  assert.equal(settings.validateIntegration({ ...mcp, transport: 'Streamable HTTP', url: 'http://localhost:3000/mcp' }), '');
  assert.match(settings.validateIntegration({ ...mcp, command: 'demo', timeout: -1 }), /超时/);
  assert.equal(settings.validateIntegration({ ...settings.newIntegration('openapi'), name: 'Example', url: 'https://example.test/openapi.json' }), '');
});

test('selected read-only roles apply their instructions and tool whitelist', () => {
  const config = defaults();
  config.agentName = '代码探索';
  const snapshot = settings.runtimeSnapshot(config, 'comfyui', composer.defaultOptions, true).join('\n');
  assert.ok(snapshot.includes(config.agents[0].instructions));
  assert.ok(snapshot.includes('可用工具（演示）：read、search'));
  assert.ok(!snapshot.includes('、write'));
});

test('configured context limits and system prompt change the usage estimate', () => {
  const base = composer.estimateContext([], '', composer.emptyContext);
  const usage = composer.estimateContext([], '', composer.emptyContext, 64000, '系统提示词');
  assert.equal(usage.limit, 64000);
  assert.ok(usage.total > base.total);
  assert.equal(composer.estimateContext([], '', composer.emptyContext, 0).limit, 128000);
});

test('Markdown fences inside system prompts cannot escape folded context', () => {
  const systemPrompt = '# Instructions\n```tsx\nconst x = 1;\n```\nFinish clearly.';
  const message = composer.composeMessage('用户请求', composer.defaultOptions, composer.emptyContext, undefined, [`系统提示词：\n${systemPrompt}`]);
  assert.ok(message.startsWith('````折叠块'));
  const result = chat.splitUserContext(message);
  assert.equal(result.text, '用户请求');
  assert.ok(result.context.includes(systemPrompt));
  assert.deepEqual(chat.splitUserContext('普通消息'), { context: '', text: '普通消息' });
  assert.deepEqual(chat.splitUserContext('```折叠块\n旧上下文\n```\n正文'), { context: '旧上下文', text: '正文' });
});

test('usage counts saved local messages and excludes archived sessions from active count', () => {
  const usage = settings.usageSummary([{ archived: false, messages: [{ role: 'user', text: '你好' }, { role: 'assistant', text: 'hello', finishedAt: 1 }] }, { archived: true, messages: [] }]);
  assert.deepEqual(usage, { sessions: 1, messages: 2, input: 1, output: 3, completed: 1 });
});
