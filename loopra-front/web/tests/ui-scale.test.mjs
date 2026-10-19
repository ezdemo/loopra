import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';
const source = await readFile(new URL('../src/lib.ts', import.meta.url), 'utf8');
let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
outputText = outputText.replaceAll("from 'react'", `from '${dataUrl('export const useState=()=>{}, useEffect=()=>{};')}'`).replaceAll("from './chat'", `from '${dataUrl('export const demoMessages={};')}'`);
const { UI_SCALE_LEVELS, normalizeUiScale } = await import(dataUrl(outputText));
test('the five zoom levels include the default and preserve exact choices', () => {
  assert.deepEqual(UI_SCALE_LEVELS, [80, 90, 100, 125, 150]);
  for (const level of UI_SCALE_LEVELS) assert.equal(normalizeUiScale(level), level);
});
test('previous continuous and legacy zoom settings select the closest level', () => {
  for (const [value, expected] of [[83.2, 80], [93, 90], [107.4, 100], [114, 125], [129, 125], [149.9, 150], [-1, 80], [500, 150]]) assert.equal(normalizeUiScale(value), expected);
});
test('invalid zoom settings fall back to 100 percent', () => {
  for (const value of [NaN, Infinity, -Infinity]) assert.equal(normalizeUiScale(value), 100);
});
