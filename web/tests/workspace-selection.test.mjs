import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://test.invalid' });
const globals = { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
after(() => {
  dom.window.close();
  for (const [key, value] of previous) {
    if (value) Object.defineProperty(globalThis, key, value);
    else delete globalThis[key];
  }
});
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText).toString('base64');
const helpers = moduleUrl(await readFile(new URL('../src/last-workspace.ts', import.meta.url), 'utf8'));
const hookSource = (await readFile(new URL('../src/useWorkspaceSelection.ts', import.meta.url), 'utf8'))
  .replace("'react'", JSON.stringify(import.meta.resolve('react')))
  .replace("'./last-workspace'", JSON.stringify(helpers));
const { useWorkspaceSelection } = await import(moduleUrl(hookSource));
const projects = [{ hash: 'a', path: '/a' }, { hash: 'b', path: '/b' }, { hash: 'c', path: '/c' }];

async function mount({ server = 'first', workspaces = projects, api = { request: async () => {} } } = {}) {
  localStorage.clear();
  let value;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let props = { server, workspaces, api };
  function Probe(next) {
    value = useWorkspaceSelection(next.server, next.api, next.workspaces, '/a');
    return createElement('output', null, value.workspace);
  }
  const render = async next => {
    props = { ...props, ...next };
    await act(async () => { root.render(createElement(Probe, props)); });
  };
  await render({});
  return {
    get value() { return value; }, render,
    async close() { await act(async () => { root.unmount(); }); container.remove(); },
  };
}

test('a late record cannot undo an explicit project selection', async () => {
  const writes = [];
  const view = await mount({ api: { request: async (_path, _method, body) => { writes.push(body.lastWorkspace); } } });
  try {
    await act(async () => { view.value.select('b'); });
    assert.equal(view.value.workspace, 'b');
    assert.deepEqual(writes, []);
    await act(async () => { view.value.receive('a'); });
    assert.equal(view.value.workspace, 'b');
    assert.deepEqual(writes, ['b']);
  } finally { await view.close(); }
});

test('the service record restores after the project list arrives without writing it back', async () => {
  const writes = [];
  const view = await mount({ workspaces: [], api: { request: async (...args) => { writes.push(args); } } });
  try {
    await act(async () => { view.value.receive('b'); });
    assert.equal(view.value.workspace, '');
    await view.render({ workspaces: projects });
    assert.equal(view.value.workspace, 'b');
    assert.deepEqual(writes, []);
  } finally { await view.close(); }
});

test('a failed read preserves local selection without overwriting the unknown service record', async () => {
  const writes = [];
  const view = await mount({ api: { request: async (...args) => { writes.push(args); } } });
  try {
    await act(async () => { view.value.fail(); view.value.select('b'); });
    assert.equal(view.value.workspace, 'b');
    await view.render({ workspaces: [...projects] });
    assert.deepEqual(writes, []);
    assert.equal(JSON.parse(localStorage.getItem('loopra:last-workspace')), 'b');
  } finally { await view.close(); }
});

test('switching services resets restoration and ignores late responses from the old service', async () => {
  const view = await mount();
  try {
    const oldReceive = view.value.receive;
    await act(async () => { view.value.select('b'); });
    await view.render({ server: 'second', api: { request: async () => {} } });
    await act(async () => { oldReceive('c'); view.value.receive('a'); });
    assert.equal(view.value.workspace, 'a');
  } finally { await view.close(); }
});

test('slow writes finish before saving the newest selection', async () => {
  const writes = [];
  let release;
  const view = await mount({ api: {
    request: async (_path, _method, body) => {
      writes.push(body.lastWorkspace);
      if (body.lastWorkspace === 'b') await new Promise(resolve => { release = resolve; });
    },
  } });
  try {
    await act(async () => { view.value.receive('a'); });
    await act(async () => { view.value.select('b'); });
    await act(async () => { view.value.select('c'); });
    assert.deepEqual(writes, ['b']);
    await act(async () => { release(); });
    assert.deepEqual(writes, ['b', 'c']);
    assert.equal(view.value.workspace, 'c');
  } finally { release?.(); await view.close(); }
});

test('removing the selected project falls back to a live project and saves that choice', async () => {
  const writes = [];
  const view = await mount({ api: { request: async (_path, _method, body) => { writes.push(body.lastWorkspace); } } });
  try {
    await act(async () => { view.value.receive('b'); });
    await view.render({ workspaces: projects.filter(item => item.hash !== 'b') });
    assert.equal(view.value.workspace, 'a');
    assert.deepEqual(writes, ['a']);
  } finally { await view.close(); }
});

test('a failed write can be retried and returning to an earlier saved project still persists', async () => {
  const writes = [];
  const warn = console.warn;
  console.warn = () => {};
  let failNext = true;
  const view = await mount({ api: {
    request: async (_path, _method, body) => {
      writes.push(body.lastWorkspace);
      if (failNext) { failNext = false; throw new Error('temporary failure'); }
    },
  } });
  try {
    await act(async () => { view.value.receive('a'); });
    await act(async () => { view.value.select('b'); });
    await act(async () => { view.value.select('b'); });
    await act(async () => { view.value.select('a'); });
    assert.deepEqual(writes, ['b', 'b', 'a']);
  } finally { console.warn = warn; await view.close(); }
});
