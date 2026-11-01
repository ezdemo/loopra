import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/desktop-update.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { createNativeDesktopUpdateApi, desktopUpdateApi } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
const state = { currentVersion: '26.11.101', latestVersion: '26.11.102', status: 'downloaded', revision: 5 };
const response = data => ({ ok: true, json: async () => ({ success: true, data }) });

test('mygo gets a stable native updater and Electron keeps its own bridge', () => {
  const previous = globalThis.window;
  try {
    delete globalThis.window;
    assert.equal(desktopUpdateApi(), undefined);
    globalThis.window = {};
    assert.equal(desktopUpdateApi(), undefined);
    window.mygo = { window: { close() {} } };
    const native = desktopUpdateApi();
    assert.equal(native, desktopUpdateApi());
    window.electronAPI = { desktopUpdate: { legacy: true } };
    assert.equal(desktopUpdateApi(), window.electronAPI.desktopUpdate);
  } finally { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; }
});

test('native commands use the local authenticated API and publish returned states', async () => {
  const calls = [], accepted = [];
  const api = createNativeDesktopUpdateApi(async (url, options) => {
    calls.push({ url, ...options });
    return response(url.endsWith('/notes') ? { currentVersion: state.currentVersion, releases: [] } : state);
  });
  const unsubscribe = api.onState(next => accepted.push(next));
  try {
    assert.equal((await api.getState()).currentVersion, '26.11.101');
    await api.check();
    await api.download();
    await api.setSource('https://ghproxy.net/');
    await api.install();
    const notes = await api.getReleaseNotes();
    assert.deepEqual(notes.releases, []);
    assert.ok(calls.every(call => call.url.startsWith('/api/desktop-update/') && call.credentials === 'same-origin' && call.signal instanceof AbortSignal));
    assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => [call.url.split('/').at(-1), JSON.parse(call.body)]), [
      ['check', {}], ['download', {}], ['source', { source: 'https://ghproxy.net/' }], ['install', {}],
    ]);
    assert.equal(accepted.length, 1, 'unchanged revisions must not repeatedly rerender the workbench');
  } finally { unsubscribe(); }
});

test('a late poll cannot roll back a newer command result', async () => {
  let resolvePoll;
  const accepted = [];
  const api = createNativeDesktopUpdateApi((url) => url.endsWith('/state')
    ? new Promise(resolve => { resolvePoll = resolve; }) : Promise.resolve(response(state)));
  const unsubscribe = api.onState(next => accepted.push(next.status));
  try {
    await api.check();
    resolvePoll(response({ ...state, status: 'checking', revision: 2 }));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(accepted, ['downloaded']);
  } finally { unsubscribe(); }
});

test('native command failures surface the backend message', async () => {
  const api = createNativeDesktopUpdateApi(async () => ({ ok: false, json: async () => ({ success: false, error: '更新包校验失败' }) }));
  await assert.rejects(api.check(), /更新包校验失败/);
});
