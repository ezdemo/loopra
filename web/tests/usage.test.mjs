import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// The composer's context popover mirrors the legacy UsagePanel: it marks the
// 80% fold threshold on the context bar and prints the threshold token count.
const source = await readFile(new URL('../src/usage.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { FOLD_THRESHOLD_RATIO, foldThreshold, contextFromUsage, contextPartPercent, formatUsageCost, usagePath } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('fold threshold matches the legacy 80% window rule', () => {
  assert.equal(FOLD_THRESHOLD_RATIO, 0.8);
  assert.equal(foldThreshold(128000), 102400);
  assert.equal(foldThreshold(200000), 160000);
  // Defensive: unknown/zero windows must not produce NaN or negative marks.
  assert.equal(foldThreshold(0), 0);
  assert.equal(foldThreshold(Number.NaN), 0);
  assert.equal(foldThreshold(-5), 0);
});

test('context view keeps the server window and exposes metrics', () => {
  const fallback = { parts: [], total: 0, limit: 128000, percent: 0 };
  const usage = {
    promptTokens: 900, completionTokens: 100, cacheHit: 3, cacheMiss: 1, lastPromptTokens: 64000,
    maxContextTokens: 200000, totalTokens: 1000, model: 'demo', hasPrice: true, totalCost: 0.5, currency: 'CNY',
    contextEstimate: { systemTokens: 1000, toolDefinitionTokens: 0, userTokens: 2000, assistantTokens: 0, toolResultTokens: 0, totalTokens: 3000, exactTokenizer: true, estimator: 'offline' },
  };
  const view = contextFromUsage(usage, fallback);
  assert.equal(view.limit, 200000);
  assert.equal(foldThreshold(view.limit), 160000);
  assert.equal(view.total, 3000);
  assert.equal(view.exact, true);
  assert.equal(view.metrics.cacheHitRate, 75);
  // Legacy UsagePanel 费用估算的三项明细随总费用一起暴露。
  assert.deepEqual(
    { input: view.metrics.inputCost, cache: view.metrics.cacheCost, output: view.metrics.outputCost },
    { input: 0, cache: 0, output: 0 },
  );
  assert.deepEqual(view.parts.map(part => part.name), ['系统指令', '用户消息']);

  const priced = contextFromUsage({ ...usage, inputCost: 0.1, cacheCost: 0.02, outputCost: 0.38 }, fallback);
  assert.deepEqual(
    { input: priced.metrics.inputCost, cache: priced.metrics.cacheCost, output: priced.metrics.outputCost },
    { input: 0.1, cache: 0.02, output: 0.38 },
  );

  // No server numbers -> keep the caller's optimistic estimate.
  assert.equal(contextFromUsage(null, fallback), fallback);
  assert.equal(contextFromUsage({ ...usage, contextEstimate: null, lastPromptTokens: 0 }, fallback), fallback);
  assert.equal(contextFromUsage({ ...usage, contextEstimate: null, lastPromptTokens: 5000 }, fallback).limit, 200000);
});

test('Agent-reported usage drives the context view without a local estimate', () => {
  const fallback = { parts: [], total: 0, limit: 128000, percent: 0 };
  // Claude Code reports context window usage over ACP; it has no breakdown and may price in USD.
  const view = contextFromUsage({
    promptTokens: 0, completionTokens: 0, cacheHit: 0, cacheMiss: 0, lastPromptTokens: 3210,
    maxContextTokens: 200000, totalTokens: 0, model: 'claude-test', hasPrice: true,
    totalCost: 0.0456, currency: 'USD', contextEstimate: null,
  }, fallback);
  assert.equal(view.total, 3210);
  assert.equal(view.limit, 200000);
  assert.equal(view.parts.length, 1);
  assert.equal(view.parts[0].name, '会话上下文');
  assert.equal(view.metrics.currency, 'USD');
  assert.equal(formatUsageCost(0.0456, 'USD'), '$0.05');
  assert.equal(formatUsageCost(0.0042, 'USD'), '$0.0042');
  assert.equal(formatUsageCost(12.345, 'USD'), '$12.35');
  assert.equal(formatUsageCost(3.7, 'CNY'), '¥3.70');
  assert.equal(formatUsageCost(1, 'EUR'), '€1.00');
  assert.equal(formatUsageCost(1, 'JPY'), '1.00 JPY');
});

test('usage path keeps the optional session name', () => {
  assert.equal(usagePath('abc'), '/usage?workspaceHash=abc');
  assert.equal(usagePath('abc', '会话 1'), '/usage?workspaceHash=abc&sessionName=%E4%BC%9A%E8%AF%9D+1');
});

const externalUsage = {
  promptTokens: 0, completionTokens: 0, cacheHit: 0, cacheMiss: 0,
  lastPromptTokens: 375000, maxContextTokens: 475000, totalTokens: 0,
  model: 'external', hasPrice: false, totalCost: 0, currency: null,
  contextSource: 'agent', contextEstimateScope: 'transcript',
  contextEstimate: { systemTokens: 0, toolDefinitionTokens: 0, userTokens: 100, assistantTokens: 300,
    toolResultTokens: 600, totalTokens: 1000, exactTokenizer: true, estimator: 'deepseek-v3-tokenizer' },
};
const externalFallback = { parts: [], total: 0, limit: 128000, percent: 0 };

test('external composition percentages use the transcript while total usage stays Agent-reported', () => {
  const view = contextFromUsage(externalUsage, externalFallback);
  assert.equal(view.total, 375000);
  assert.equal(view.limit, 475000);
  assert.equal(view.percent, 375000 / 475000 * 100);
  assert.equal(view.estimatedComposition, true);
  assert.equal(view.source, 'agent');
  assert.deepEqual(view.parts.map(part => part.name), ['用户消息', '助手消息', '工具结果']);
  assert.deepEqual(view.parts.map(part => contextPartPercent(part, view)), [10, 30, 60]);
  const gauge = view.parts.reduce((sum, part) => sum + contextPartPercent(part, view) / 100 * view.percent, 0);
  assert.ok(Math.abs(gauge - view.percent) < 1e-9);
});

test('zero reported context stays zero after compaction even when transcript is nonempty', () => {
  const view = contextFromUsage({ ...externalUsage, lastPromptTokens: 0 }, externalFallback);
  assert.equal(view.total, 0);
  assert.equal(view.percent, 0);
  assert.deepEqual(view.parts.map(part => contextPartPercent(part, view)), [10, 30, 60]);
});

test('server-estimated external usage uses its own known window and marks its source', () => {
  const view = contextFromUsage({ ...externalUsage, contextSource: 'loopra', lastPromptTokens: 0, maxContextTokens: 200000 }, externalFallback);
  assert.equal(view.total, 1000);
  assert.equal(view.percent, 0.5);
  assert.equal(view.source, 'loopra');
});

test('an unknown external window never falls back to the Native window', () => {
  const view = contextFromUsage({ ...externalUsage, contextSource: 'loopra', lastPromptTokens: 0, maxContextTokens: 0 }, externalFallback);
  assert.equal(view.total, 1000);
  assert.equal(view.limit, 0);
  assert.equal(view.windowKnown, false);
  assert.equal(view.percent, 0);
  assert.deepEqual(view.parts.map(part => contextPartPercent(part, view)), [10, 30, 60]);
});
