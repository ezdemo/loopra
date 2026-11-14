import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

async function compile(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  return 'data:text/javascript;base64,' + Buffer.from(outputText).toString('base64');
}
const { filterConnectors, sortConnectors, statusDisplay, connectPayload, missingFields, reduceFlow, connectorRequestOf, connectorsForView, installedCustomConnectors, customStatusDisplay, customDescription, suggestConnectorName, customDraftFromServer, customDraftPayload, customDraftError } = await import(await compile('../src/connectors.ts'));

const base = { enabled: false, requirementsMet: true, fields: [] };
const items = [
  { ...base, id: 'notion', name: 'Notion', category: 'office', status: 'available', description: '页面与数据库', capabilities: ['搜索页面'] },
  { ...base, id: 'amap', name: '高德地图', category: 'life', status: 'connected', enabled: true, description: '地点搜索、路线规划', capabilities: ['路线规划'] },
  { ...base, id: 'gmail', name: 'Gmail', category: 'office', status: 'needs_reauth', description: '搜索和阅读邮件' },
];

test('filterConnectors 按分类过滤', () => {
  assert.deepEqual(filterConnectors(items, 'office', '').map(i => i.id), ['notion', 'gmail']);
  assert.deepEqual(filterConnectors(items, 'all', '').map(i => i.id), ['notion', 'amap', 'gmail']);
});

test('filterConnectors 匹配名称、说明与能力', () => {
  assert.deepEqual(filterConnectors(items, '', '路线').map(i => i.id), ['amap']);
  assert.deepEqual(filterConnectors(items, '', 'notion').map(i => i.id), ['notion']);
  assert.deepEqual(filterConnectors(items, '', '邮件').map(i => i.id), ['gmail']);
  assert.deepEqual(filterConnectors(items, '', '不存在'), []);
});

test('sortConnectors 已连接与待重授权排前，组内保持顺序', () => {
  assert.deepEqual(sortConnectors(items).map(i => i.id), ['amap', 'gmail', 'notion']);
});

test('statusDisplay 提供文字与色调', () => {
  assert.equal(statusDisplay('connected').label, '已连接');
  assert.equal(statusDisplay('needs_reauth').tone, 'warn');
  assert.equal(statusDisplay('missing_requirement').label, '缺少运行环境');
});

test('connectPayload 去掉空白字段', () => {
  assert.deepEqual(connectPayload({ token: 'abc', extra: '  ', other: '' }), { fields: { token: 'abc' } });
});

test('missingFields 报告未填写的必填字段', () => {
  const item = { ...base, fields: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] };
  assert.deepEqual(missingFields(item, { a: 'x' }), ['b']);
});

test('reduceFlow 只在等待阶段推进', () => {
  assert.equal(reduceFlow('form', { status: 'connected' }), 'form');
  assert.equal(reduceFlow('waiting', { status: 'pending' }), 'waiting');
  assert.equal(reduceFlow('waiting', { status: 'connected' }), 'connected');
  assert.equal(reduceFlow('waiting', { status: 'failed', error: '授权失败' }), 'failed');
  assert.equal(reduceFlow('connected', { status: 'pending' }), 'connected');
});

test('connectorRequestOf 识别连接器提问标记', () => {
  const request = connectorRequestOf({ schema: { type: 'object', properties: {}, 'x-loopra-connector': { id: 'amap', name: '高德地图', reason: '查天气', needs: 'connect' } } });
  assert.deepEqual(request, { id: 'amap', name: '高德地图', reason: '查天气', needs: 'connect' });
});

test('connectorRequestOf 对普通提问或非法标记返回 undefined', () => {
  assert.equal(connectorRequestOf({ schema: { type: 'object', properties: { city: { type: 'string' } } } }), undefined);
  assert.equal(connectorRequestOf(undefined), undefined);
  assert.equal(connectorRequestOf({ schema: { 'x-loopra-connector': { name: '无 id' } } }), undefined);
  assert.equal(connectorRequestOf({ schema: { 'x-loopra-connector': { id: 'amap', needs: 'bogus' } } }), undefined);
});

test('connectorsForView 按我的内容与发现拆分', () => {
  const all = [
    { ...base, id: 'amap', name: '高德', category: 'life', status: 'connected' },
    { ...base, id: 'gmail', name: 'Gmail', category: 'office', status: 'needs_reauth' },
    { ...base, id: 'notion', name: 'Notion', category: 'office', status: 'available' },
    { ...base, id: 'ding', name: '钉钉', category: 'office', status: 'missing_requirement' },
  ];
  assert.deepEqual(connectorsForView(all, 'installed').map(i => i.id), ['amap', 'gmail']);
  assert.deepEqual(connectorsForView(all, 'discover').map(i => i.id), ['notion', 'ding']);
});

test('custom helpers: installedCustomConnectors filters by query', () => {
  const custom = [
    { name: 'notion', type: 'streamable', enabled: true, url: 'https://mcp.notion.com/mcp' },
    { name: 'everything', type: 'stdio', enabled: false, command: 'npx' },
  ];
  assert.deepEqual(installedCustomConnectors(custom, '').map(s => s.name), ['notion', 'everything']);
  assert.deepEqual(installedCustomConnectors(custom, 'notion').map(s => s.name), ['notion']);
  assert.deepEqual(installedCustomConnectors(custom, 'npx').map(s => s.name), ['everything']);
  assert.deepEqual(installedCustomConnectors(custom, 'nope'), []);
});

test('customStatusDisplay distinguishes auth states', () => {
  assert.deepEqual(customStatusDisplay({ name: 'a', type: 'stdio', enabled: true }).label, '自定义');
  assert.equal(customStatusDisplay({ name: 'a', type: 's', enabled: true, authStatus: 'connected' }).label, '已连接');
  assert.equal(customStatusDisplay({ name: 'a', type: 's', enabled: true, authStatus: 'needs_reauth' }).label, '需要重新授权');
});

test('customDescription shows host or command', () => {
  assert.equal(customDescription({ name: 'a', type: 'streamable', enabled: true, url: 'https://mcp.notion.com/mcp' }), 'mcp.notion.com');
  assert.equal(customDescription({ name: 'a', type: 'stdio', enabled: true, command: 'npx' }), 'npx');
});

test('suggestConnectorName derives from url host and command', () => {
  assert.equal(suggestConnectorName({ url: 'https://mcp.notion.com/mcp' }), 'notion');
  assert.equal(suggestConnectorName({ url: 'https://api.github.com/mcp' }), 'github');
  assert.equal(suggestConnectorName({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] }), 'everything');
  assert.equal(suggestConnectorName({ command: '/usr/local/bin/my-server' }), 'my-server');
});

test('customDraftPayload preserves unknown fields and parses pairs', () => {
  const existing = { name: 'notion', type: 'streamable', url: 'https://old/mcp', enabled: true, disallowedTools: ['x'], oauth: { clientId: 'c' }, futureField: 1 };
  const draft = { ...customDraftFromServer(existing), url: 'https://mcp.notion.com/mcp', headersText: 'Authorization: Bearer t\nX-A: b', timeout: '45s' };
  const payload = customDraftPayload(draft, existing);
  assert.equal(payload.name, 'notion');
  assert.equal(payload.url, 'https://mcp.notion.com/mcp');
  assert.equal(payload.disallowedTools.length, 1);
  assert.equal(payload.futureField, 1);
  assert.deepEqual(payload.headers, { Authorization: 'Bearer t', 'X-A': 'b' });
  assert.equal(payload.timeout, '45s');
  assert.equal(payload.oauth.clientId, 'c');
});

test('customDraftPayload for stdio strips remote fields; validation catches bad input', () => {
  const draft = { ...customDraftFromServer(undefined), mode: 'stdio', command: 'npx', argsText: '-y\nserver-everything', envText: 'KEY=VALUE' };
  const payload = customDraftPayload(draft);
  assert.equal(payload.type, 'stdio');
  assert.deepEqual(payload.args, ['-y', 'server-everything']);
  assert.deepEqual(payload.env, { KEY: 'VALUE' });
  assert.equal(payload.url, undefined);
  assert.equal(customDraftError({ ...draft, name: 'bad name' }, [], ''), '名称只能包含字母、数字、下划线和连字符');
  assert.equal(customDraftError(draft, []), '');
});
