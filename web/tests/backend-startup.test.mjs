import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const dataUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const backendUrl = dataUrl(`
  export const pending = new Map();
  export const requests = [];
  export class LoopraClient {
    async request(path) {
      requests.push(path);
      const ready = {
        '/system/health': { version: 'test' }, '/agent/status': { ready: true },
        '/config': { modelChannels: [] }, '/workspaces': [{ hash: 'project', name: 'Project', path: '/project' }],
        '/sessions?workspaceHash=project': [{ name: 'saved' }], '/version/check': {},
      };
      if (path in ready) return ready[path];
      return new Promise(resolve => pending.set(path, resolve));
    }
  }
  export const configProviders = () => [];
  export const withChatWorkspace = projects => projects;
  export const remoteSession = (item, project) => ({ id: project.hash + '/' + item.name, messages: [] });
`);
const source = await readFile(new URL('../src/useLoopra.ts', import.meta.url), 'utf8');
let code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
code = code.replaceAll("'react'", JSON.stringify(import.meta.resolve('react'))).replaceAll("'./backend'", JSON.stringify(backendUrl));
const { default: useLoopra } = await import(dataUrl(code));
const { pending, requests } = await import(backendUrl);
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');

test('slow tool and skill discovery cannot keep a healthy session backend in connecting state', async () => {
  const dom = new JSDOM('<body><div id="root"></div></body>', { url: 'http://test.invalid' });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let backend;
  function Harness() { backend = useLoopra('http://test.invalid'); return null; }
  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () => { root.render(createElement(Harness)); await new Promise(resolve => setImmediate(resolve)); });
    assert.equal(backend.status, 'connected');
    assert.equal(backend.ready, true);
    assert.equal(backend.sessions.length, 1);
    assert.equal(backend.sessionsLoading, false);
    assert.ok(pending.has('/tools'));
    assert.ok(pending.has('/agent/skills'));
    await act(async () => {
      pending.get('/tools')([{ name: 'read', readOnly: true }]);
      pending.get('/agent/skills')([{ name: 'skill', description: 'Loaded later' }]);
      pending.get('/loopra-md')('prompt');
    });
    assert.equal(backend.tools.length, 1);
    assert.equal(backend.skills.length, 1);
    assert.equal(backend.prompt, 'prompt');
    assert.equal(backend.status, 'connected');
    const sessions = backend.sessions;
    const start = requests.length;
    let refreshing;
    await act(async () => { refreshing = backend.refreshCapabilities(); });
    assert.equal(backend.status, 'connected');
    assert.equal(backend.sessions, sessions);
    assert.deepEqual(requests.slice(start), ['/tools', '/agent/skills']);
    await act(async () => {
      pending.get('/tools')([{ name: 'plugin-tool', readOnly: false }]);
      pending.get('/agent/skills')([{ name: 'installed-skill', description: 'New' }]);
      await refreshing;
    });
    assert.equal(backend.tools[0].name, 'plugin-tool');
    assert.equal(backend.tools[0].category, '写入工具');
    assert.equal(backend.skills[0].name, 'installed-skill');
    assert.equal(backend.sessions, sessions);
    assert.equal(backend.status, 'connected');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});

test('the home shell can mount without requesting an unready desktop service', async () => {
  const dom = new JSDOM('<body><div id="root"></div></body>', { url: 'http://test.invalid' });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let backend;
  function Harness({ enabled }) { backend = useLoopra('http://test.invalid', enabled); return null; }
  const root = createRoot(document.getElementById('root'));
  try {
    requests.length = 0;
    await act(async () => root.render(createElement(Harness, { enabled: false })));
    assert.deepEqual(requests, []);
    assert.equal(backend.status, 'connecting');
    assert.equal(backend.sessionsLoading, true);
    await act(async () => {
      root.render(createElement(Harness, { enabled: true }));
      await new Promise(resolve => setImmediate(resolve));
    });
    assert.equal(backend.status, 'connected');
    assert.equal(backend.sessionsLoading, false);
    assert.equal(backend.sessions.length, 1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  }
});
