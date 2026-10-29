import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });

const { act, createElement, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const moduleUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
async function moduleCode(file) {
  return ts.transpileModule(await readFile(new URL('../src/' + file, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
}
const tabsUrl = moduleUrl(await moduleCode('workspace-tabs.ts'));
const sessionsUrl = moduleUrl(await moduleCode('sub-sessions.ts'));
let hook = await moduleCode('useSubAgentTabs.ts');
hook = hook.replaceAll("'react'", JSON.stringify(import.meta.resolve('react')))
  .replaceAll("'./workspace-tabs'", JSON.stringify(tabsUrl)).replaceAll("'./sub-sessions'", JSON.stringify(sessionsUrl));
const { useSubAgentTabs } = await import(moduleUrl(hook));
const target = { id: 'p/chat', kind: 'remote', name: 'chat', workspaceHash: 'p', messages: [] };
const run = { subSessionId: 'codex-child', name: 'Codex', title: '检查代码', task: '检查代码', status: 'completed' };

function mount(api, initial = {}, session = target, runId = null) {
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  let state;
  function View({ session, runId }) {
    const [tabs, setTabs] = useState(initial); state = tabs;
    useSubAgentTabs(api, 'server', session, true, runId, setTabs);
    return null;
  }
  const render = (session, runId) => act(async () => root.render(createElement(View, { session, runId })));
  return { render, start: () => render(session, runId), state: () => state,
    close() { act(() => root.unmount()); container.remove(); } };
}

test('reopening a session recovers saved Codex tabs without stealing file focus or duplicating a tab', async () => {
  const view = mount({ request: async () => [run] }, { 'server/p': { files: [{ path: 'a.ts', mode: 'content' }], agents: [], active: 'a.ts' } });
  try {
    await view.start();
    assert.equal(view.state()['server/p'].agents[0].label, 'Codex：检查代码');
    assert.equal(view.state()['server/p'].active, 'a.ts');
    await view.render(target, 'request');
    await view.render(target, null);
    assert.equal(view.state()['server/p'].agents.length, 1);
  } finally { view.close(); }
});

test('finishing a turn recovers children rebuilt during ACP session/load', async () => {
  let runs = [];
  const view = mount({ request: async () => runs }, {}, target, 'request');
  try {
    await view.start();
    assert.equal(view.state()['server/p'].agents.length, 0);
    runs = [run];
    await view.render(target, null);
    assert.equal(view.state()['server/p'].agents[0].subSessionId, 'codex-child');
    assert.equal(view.state()['server/p'].active, null);
  } finally { view.close(); }
});

test('a late reply from a previous workspace cannot restore stale tabs', async () => {
  let release;
  const view = mount({ request: path => path.includes('workspaceHash=p&') ? new Promise(resolve => { release = resolve; }) : Promise.resolve([]) });
  try {
    await view.start();
    await view.render({ ...target, id: 'q/other', name: 'other', workspaceHash: 'q' }, null);
    await act(async () => release([run]));
    assert.equal(view.state()['server/p'], undefined);
    assert.equal(view.state()['server/q'].agents.length, 0);
  } finally { view.close(); }
});
