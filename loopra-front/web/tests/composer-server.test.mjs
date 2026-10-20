import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const load = async name => {
  const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  return import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
};

const { acpSlashCommands, mergeSlashCommands, serverSlashCommands, localSlashCommands, presetPayload, presetsFromServer, formatTokenSpeed } = await load('composer.ts');
const { contextFromUsage, usagePath } = await load('usage.ts');

test('server slash commands merge skills, drop plan toggles and keep local actions first', () => {
  const remote = serverSlashCommands(
    [{ cmd: '/compact', desc: '折叠上下文' }, { cmd: '/plan' }, { cmd: '/new', desc: '新建' }, { cmd: '/init', desc: '初始化' }],
    [{ name: 'code-review', description: '审查代码' }, { name: '' }],
  );
  assert.deepEqual(remote.map(item => item.id), ['/compact', '/new', '/init', '/skill:code-review']);
  const local = [{ id: '/new', title: '新建会话', description: '', action: () => {} }];
  const merged = mergeSlashCommands(local, remote);
  assert.equal(merged[0].action instanceof Function, true);
  assert.deepEqual(merged.map(item => item.id), ['/new', '/compact', '/init', '/skill:code-review']);
  assert.equal(merged.find(item => item.id === '/compact').insert, '/compact ');
});

test('external Agent command discovery retains plan commands and native skill syntax is not invented', () => {
  const commands = acpSlashCommands([{ name: 'plan', description: '计划' }, { name: 'review', inputHint: 'branch' }, { name: 'custom-skill' }, { name: 'plan' }, { name: '' }]);
  assert.deepEqual(commands.map(command => command.id), ['/plan', '/review', '/custom-skill']);
  assert.equal(commands[0].insert, '/plan ');
  assert.equal(commands[1].description, 'branch');
});

test('local slash commands expose the browser-side actions the legacy menu had', () => {
  const calls = [];
  const commands = localSlashCommands({
    onNew: () => calls.push('new'), onContinue: () => calls.push('continue'), onSkills: () => calls.push('skills'),
    onHelp: () => calls.push('help'), onExport: () => calls.push('export'), onSessions: () => calls.push('sessions'),
    onTerminal: () => calls.push('terminal'), onClear: () => calls.push('clear'),
    hasHistory: true, busy: false, notify: message => calls.push(`notify:${message}`),
  });
  // `/clear` mirrors legacy Chat.vue: the backend /new command is gone, so it
  // opens a fresh session in the same workspace.
  assert.deepEqual(commands.map(item => item.id), ['/new', '/clear', '/export', '/sessions', '/continue', '/skills', '/terminal', '/help']);
  for (const command of commands) command.action();
  assert.deepEqual(calls, ['new', 'clear', 'export', 'sessions', 'continue', 'skills', 'terminal', 'help']);

  // Without history `/continue` falls back to a hint instead of generating.
  calls.length = 0;
  const empty = localSlashCommands({ ...{ onNew() {}, onSkills() {}, onHelp() {}, onExport() {}, onSessions() {}, onTerminal() {}, onClear() {} }, onContinue: () => calls.push('continue'), hasHistory: false, busy: false, notify: message => calls.push(message) });
  empty.find(item => item.id === '/continue').action();
  assert.deepEqual(calls, ['请先开始会话']);
});

test('prompt presets round-trip between the name field and the server label field', () => {
  const payload = presetPayload([{ id: 'a', name: '最小范围', text: '只改必要的' }]);
  assert.deepEqual(payload, { presets: [{ id: 'a', label: '最小范围', text: '只改必要的' }] });
  assert.deepEqual(presetsFromServer([{ id: 'b', label: '验证', text: '跑测试' }, { label: '', text: 'x' }]),
    [{ id: 'b', name: '验证', text: '跑测试' }]);
  assert.deepEqual(presetsFromServer(null), []);
});

test('context usage prefers real server numbers and falls back to the estimate', () => {
  const fallback = { parts: [{ name: '本地', tokens: 10, color: '#000' }], total: 10, limit: 1000, percent: 1 };
  assert.equal(contextFromUsage(null, fallback), fallback);
  assert.equal(contextFromUsage({ lastPromptTokens: 0, maxContextTokens: 128000 }, fallback), fallback);

  const usage = contextFromUsage({
    promptTokens: 1200, completionTokens: 340, cacheHit: 800, cacheMiss: 200, lastPromptTokens: 1500,
    maxContextTokens: 10000, totalTokens: 1540, model: 'm', hasPrice: true, totalCost: 0.42, currency: 'CNY',
    contextEstimate: { systemTokens: 500, toolDefinitionTokens: 200, userTokens: 300, assistantTokens: 400, toolResultTokens: 100, totalTokens: 1500, exactTokenizer: true, estimator: 'tiktoken' },
  }, fallback);
  assert.equal(usage.exact, true);
  assert.equal(usage.total, 1500);
  assert.equal(usage.limit, 10000);
  assert.equal(usage.percent, 15);
  assert.equal(usage.parts.reduce((sum, part) => sum + part.tokens, 0), 1500);
  assert.equal(usage.metrics.cacheHitRate, 80);
  assert.equal(usage.metrics.totalCost, 0.42);

  const coarse = contextFromUsage({ lastPromptTokens: 400, maxContextTokens: 0, promptTokens: 0, completionTokens: 0, cacheHit: 0, cacheMiss: 0, totalTokens: 0, model: '', hasPrice: false, totalCost: 0, currency: '', contextEstimate: null }, fallback);
  assert.equal(coarse.exact, false);
  assert.equal(coarse.limit, 1000);
  assert.equal(coarse.parts.length, 1);
});

test('usagePath encodes the workspace hash and optional session name', () => {
  assert.equal(usagePath('abc'), '/usage?workspaceHash=abc');
  assert.equal(usagePath('a b', 's/1'), '/usage?workspaceHash=a+b&sessionName=s%2F1');
});

test('token speed matches legacy displayTps rounding and done/streaming choice', () => {
  assert.equal(formatTokenSpeed(undefined), '');
  assert.equal(formatTokenSpeed({ tokensPerSecond: 0 }), '');
  assert.equal(formatTokenSpeed({ tokensPerSecond: 12.34 }), '12.3 t/s');
  assert.equal(formatTokenSpeed({ tokensPerSecond: 120.6 }), '121 t/s');
  // While streaming, the live rate wins; once done, the average takes over.
  assert.equal(formatTokenSpeed({ tokensPerSecond: 40, avgTokensPerSecond: 20, done: false }), '40.0 t/s');
  assert.equal(formatTokenSpeed({ tokensPerSecond: 40, avgTokensPerSecond: 20, done: true }), '20.0 t/s');
  assert.equal(formatTokenSpeed({ tokensPerSecond: 40, done: true }), '40.0 t/s');
});
