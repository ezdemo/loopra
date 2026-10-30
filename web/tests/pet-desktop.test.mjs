import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/pet-desktop.ts', import.meta.url), 'utf8');
const react = 'data:text/javascript,' + encodeURIComponent('export function useEffect() {} export function useRef(value) { return { current: value }; } export function useState(value) { return [value, () => {}]; }');
let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
outputText = outputText.replaceAll("from 'react'", `from ${JSON.stringify(react)}`).replaceAll('from "react"', `from ${JSON.stringify(react)}`);
const { petDesktopBody } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('native pet requests carry the reply, the click line, and the dismiss generation', () => {
  assert.deepEqual(petDesktopBody({
    shown: true, name: 'cat', label: '小猫', activity: 'running',
    reply: { id: 'm1', text: '好了', activity: 'waving' }, latest: '上一句', scale: 0.75, seen: 2,
  }), {
    shown: true, name: 'cat', label: '小猫', activity: 'running',
    reply: '好了', replyId: 'm1', replyActivity: 'waving', latest: '上一句', scale: 0.75, seen: 2, reset: false,
  });
  assert.equal(petDesktopBody({
    shown: false, activity: 'idle', reply: null, latest: '', scale: 0.55, seen: 0, reset: true,
  }).reset, true);
});
