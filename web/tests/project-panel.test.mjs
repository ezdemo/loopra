import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { accentColorUrl } from './helpers/accent-color.mjs';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => {
  dom.window.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
});

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const dataUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
async function sourceUrl(name, dependencies = {}) {
  const source = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  for (const [specifier, url] of Object.entries({ react: import.meta.resolve('react'), ...dependencies })) {
    outputText = outputText.replaceAll(`'${specifier}'`, JSON.stringify(url)).replaceAll(`"${specifier}"`, JSON.stringify(url));
  }
  return dataUrl(outputText);
}
const libUrl = await sourceUrl('lib.ts', { './chat': dataUrl('export const demoMessages = {};'), './accent-color': accentColorUrl });
const { useProjectPanel } = await import(await sourceUrl('useProjectPanel.ts', { './lib': libUrl }));

test('each project restores its panel visibility and tab across remounts', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  let root = createRoot(container);
  let panel;
  function Harness({ server, workspace }) {
    panel = useProjectPanel(server, workspace);
    return null;
  }
  const render = async (workspace, server = 'server-a') => {
    await act(async () => root.render(createElement(Harness, { server, workspace })));
  };
  const state = () => [panel[0], panel[2]];
  try {
    await render('project-a');
    assert.deepEqual(state(), [false, 'files']);
    await act(async () => { panel[1](true); panel[3]('git'); });
    await render('project-b');
    assert.deepEqual(state(), [false, 'files']);
    await act(async () => { panel[1](true); panel[3]('capabilities'); panel[1](false); });
    await render('project-a');
    assert.deepEqual(state(), [true, 'git']);
    await render('project-b');
    assert.deepEqual(state(), [false, 'capabilities']);

    await act(async () => root.unmount());
    root = createRoot(container);
    await render('project-a');
    assert.deepEqual(state(), [true, 'git']);
    await render('project-b');
    assert.deepEqual(state(), [false, 'capabilities']);
    await render('project-a', 'server-b');
    assert.deepEqual(state(), [false, 'files']);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
