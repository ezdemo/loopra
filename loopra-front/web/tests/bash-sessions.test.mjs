import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Background bash session view-model helpers (legacy BashSessionManager.vue).
const source = await readFile(new URL('../src/bash-sessions.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { bashSessionLogPath, bashSessionState, bashSessionSummary, bashSessionsPath, formatBashDuration, formatBashUptime, runningCount, workspaceName } =
  await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('endpoints scope every call to the workspace hash', () => {
  assert.equal(bashSessionsPath('hash 1'), '/agent/bash-sessions?workspaceHash=hash%201');
  assert.equal(bashSessionLogPath('hash 1', 'a/b'), '/agent/bash-sessions/log?workspaceHash=hash%201&sessionId=a%2Fb');
});

test('durations collapse to a single legacy unit', () => {
  assert.equal(formatBashDuration(0), '0 秒');
  assert.equal(formatBashDuration(59.8), '59 秒');
  assert.equal(formatBashDuration(61), '1 分钟');
  assert.equal(formatBashDuration(3600), '1 小时');
  assert.equal(formatBashDuration(90_000), '1 天');
  assert.equal(formatBashDuration(Number.NaN), '0 秒');
});

test('uptime only counts running sessions and tolerates missing timestamps', () => {
  const now = Date.UTC(2026, 0, 2, 4, 0, 0);
  assert.equal(formatBashUptime({ sessionId: 'a', command: 'npm test', status: 'running', startedAt: now - 90_000 }, now), '已运行 1 分钟');
  assert.equal(formatBashUptime({ sessionId: 'b', command: 'npm test', status: 'completed', startedAt: now - 90_000 }, now), '已结束');
  assert.equal(formatBashUptime({ sessionId: 'c', command: 'ls', status: 'running' }, now), '启动时间未知');
});

test('summary counts running processes like the legacy header', () => {
  const sessions = [{ sessionId: 'a', command: 'a', status: 'running' }, { sessionId: 'b', command: 'b', status: 'completed' }];
  assert.equal(runningCount(sessions), 1);
  assert.equal(bashSessionSummary(sessions), '1 个运行中 · 共 2 个进程');
  assert.equal(bashSessionSummary([]), '暂无后台进程');
  assert.equal(bashSessionState({ sessionId: 'a', command: 'a', status: 'running' }), '运行中');
  assert.equal(bashSessionState({ sessionId: 'b', command: 'b', status: 'completed' }), '已结束');
});

test('workspace paths render as their trailing folder on either separator', () => {
  assert.equal(workspaceName('C:\\Users\\me\\proj'), 'proj');
  assert.equal(workspaceName('/home/me/proj/'), 'proj');
  assert.equal(workspaceName(''), '');
});
