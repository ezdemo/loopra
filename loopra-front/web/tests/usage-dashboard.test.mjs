import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

// The dashboard mirrors legacy Dashboard.vue helpers: compact token numbers and
// a Monday-first weekly heatmap with month labels.
const reactUrl = import.meta.resolve('react');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const source = await readFile(new URL('../src/components/UsageDashboard.tsx', import.meta.url), 'utf8');
let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } });
const deps = {
  react: reactUrl, 'react/jsx-runtime': import.meta.resolve('react/jsx-runtime'),
  '@nextui-org/react': dataUrl('export const Button = () => null;'),
  './RemoteControls': dataUrl('export const RemoteState = () => null; export function useRemote() { return { data: undefined }; }'),
  './SettingControls': dataUrl('export const PageHeader = () => null;'),
};
for (const [specifier, url] of Object.entries(deps)) outputText = outputText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
const { compactTokens, formatCost, usageHeatmap, usageModelPage } = await import(dataUrl(outputText));

test('compactTokens folds large numbers into 千/万/亿', () => {
  assert.equal(compactTokens(0), '0');
  assert.equal(compactTokens(999), '999');
  assert.equal(compactTokens(1500), '1.5千');
  assert.equal(compactTokens(23000), '2.3万');
  assert.equal(compactTokens(250000000), '2.5亿');
});

test('formatCost keeps four decimals only for sub-cent amounts', () => {
  assert.equal(formatCost(0), '0.00');
  assert.equal(formatCost(0.004), '0.0040');
  assert.equal(formatCost(0.01), '0.01');
  assert.equal(formatCost(12.3456), '12.35');
});

test('usageModelPage paginates four models per page and clamps the page', () => {
  const models = Array.from({ length: 9 }, (_, index) => ({ model: `m${index}`, totalTokens: 0, cost: 0, requests: 0 }));
  const first = usageModelPage(models, 1);
  assert.equal(first.totalPages, 3);
  assert.deepEqual(first.items.map(item => item.model), ['m0', 'm1', 'm2', 'm3']);
  const last = usageModelPage(models, 3);
  assert.deepEqual(last.items.map(item => item.model), ['m8']);
  // Out-of-range请求会被夹回有效范围，空列表也至少显示一页。
  assert.equal(usageModelPage(models, 99).page, 3);
  assert.equal(usageModelPage([], 2).totalPages, 1);
  assert.equal(usageModelPage([], 2).page, 1);
});

test('usageHeatmap lays out a Monday-first grid with month labels', () => {
  // 2026-09-14 is a Monday, so the grid starts with no leading blanks.
  const daily = [
    { date: '2026-09-14', totalTokens: 100, cost: 0, requests: 1 },
    { date: '2026-09-15', totalTokens: 0, cost: 0, requests: 0 },
    { date: '2026-09-16', totalTokens: 1000, cost: 0, requests: 2 },
  ];
  const { cols, cells, months } = usageHeatmap(daily);
  assert.equal(cols, 1);
  assert.equal(cells.length, 3);
  assert.equal(cells[0].level, 'level-1');
  assert.equal(cells[1].level, 'level-0');
  assert.equal(cells[2].level, 'level-4');
  assert.match(cells[2].title, /2026-09-16/);
  assert.deepEqual(months, [{ key: '2026-8', label: '9月', col: 0 }]);
});

test('usageHeatmap pads weekend offset for a mid-week start', () => {
  // 2026-09-16 is a Wednesday → two leading placeholder cells.
  const daily = [{ date: '2026-09-16', totalTokens: 10, cost: 0, requests: 1 }];
  const { cells } = usageHeatmap(daily);
  assert.equal(cells.length, 3);
  assert.equal(cells[0].level, 'empty');
  assert.equal(cells[1].level, 'empty');
});
