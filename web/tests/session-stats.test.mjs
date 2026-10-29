import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Pure view-model helpers for the session-management screen (legacy
// src/views/Sessions.vue formulas). No DOM required.
const source = await readFile(new URL('../src/session-stats.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const module = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
const { sessionMetrics, formatTokenUsage, filterSessions, paginate, formatSessionTime, sessionExportPayload } = module;

test('metrics mirror the legacy summary cards', () => {
  const metrics = sessionMetrics([{ id: 'a', title: 'a', messageCount: 12 }, { id: 'b', title: 'b', messageCount: 8 }]);
  assert.equal(metrics.sessionCount, 2);
  assert.equal(metrics.totalMessages, 20);
  assert.equal(metrics.totalToolCalls, 12);
  assert.equal(metrics.averageSessionLength, '2h 0m');
  assert.deepEqual(sessionMetrics([]), { sessionCount: 0, totalMessages: 0, totalToolCalls: 0, averageSessionLength: '0h 0m' });
});

test('token formatting matches the legacy thresholds', () => {
  assert.equal(formatTokenUsage(0), '0');
  assert.equal(formatTokenUsage(999), '999');
  assert.equal(formatTokenUsage(2500), '2.5K');
  assert.equal(formatTokenUsage(2_000_000), '2.0M');
});

test('search matches title, session name and workspace case-insensitively', () => {
  const sessions = [
    { id: 'h/one', title: '修复登录', name: 'one', workspace: 'alpha' },
    { id: 'h/two', title: 'Add tests', name: 'two', workspace: 'beta' },
  ];
  assert.equal(filterSessions(sessions, '   ').length, 2);
  assert.deepEqual(filterSessions(sessions, 'ALPHA').map(item => item.id), ['h/one']);
  assert.deepEqual(filterSessions(sessions, 'two').map(item => item.id), ['h/two']);
});

test('paging clamps to the available range', () => {
  const items = Array.from({ length: 12 }, (_, index) => index);
  assert.deepEqual(paginate(items, 1, 10), { page: 1, totalPages: 2, items: items.slice(0, 10) });
  assert.deepEqual(paginate(items, 2, 10), { page: 2, totalPages: 2, items: [10, 11] });
  assert.equal(paginate(items, 9, 10).page, 2);
  assert.equal(paginate([], 3, 10).totalPages, 1);
});

test('export payload is JSON with an exported timestamp and the original fields', () => {
  const payload = JSON.parse(sessionExportPayload({ id: 'h/one', title: '修复登录', name: 'one', messageCount: 4 }));
  assert.equal(payload.title, '修复登录');
  assert.equal(payload.messageCount, 4);
  assert.ok(!Number.isNaN(Date.parse(payload.exportedAt)));
});

test('session timestamps render as a stable local string', () => {
  assert.equal(formatSessionTime(undefined), '—');
  assert.equal(formatSessionTime(Number.NaN), '—');
  assert.match(formatSessionTime(Date.UTC(2026, 0, 2, 3, 4)), /^2026-01-0[12] \d{2}:0[34]$/);
});
