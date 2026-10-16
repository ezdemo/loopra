import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// The composer's context popover mirrors the legacy UsagePanel: it marks the
// 80% fold threshold on the context bar and prints the threshold token count.
const source = await readFile(new URL('../src/usage.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { FOLD_THRESHOLD_RATIO, foldThreshold, contextFromUsage, usagePath } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

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

test('usage path keeps the optional session name', () => {
  assert.equal(usagePath('abc'), '/usage?workspaceHash=abc');
  assert.equal(usagePath('abc', '会话 1'), '/usage?workspaceHash=abc&sessionName=%E4%BC%9A%E8%AF%9D+1');
});
