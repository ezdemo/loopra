import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../../src/services/access-key.js', import.meta.url), 'utf8');
async function setup(url = 'http://127.0.0.1:43976/index.html', respond = () => Response.json({ success: true })) {
  const dom = new JSDOM('<body></body>', { url });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, history: dom.window.history });
  const calls = [];
  window.fetch = async (input, init) => { calls.push({ url: String(input), init }); return respond(input, init); };
  const auth = await import(`data:text/javascript;base64,${Buffer.from(source + `\n// ${Math.random()}`).toString('base64')}`);
  auth.installAccessKeyProtocol();
  return { ...auth, calls, dom };
}

test('launch URL is verified, saved per server, and scrubbed from the address bar', async () => {
  const auth = await setup('http://127.0.0.1:43976/index.html?rk=launch-key&other=1#chat');
  await auth.ensureAccess(window.location.origin, true);
  assert.equal(auth.getAccessKey(window.location.origin), 'launch-key');
  assert.equal(window.location.href, 'http://127.0.0.1:43976/index.html?other=1#chat');
  assert.equal(auth.calls[0].init.headers['X-Loopra-Key'], 'launch-key');
  assert.equal(auth.getAccessKey('http://127.0.0.1:43977'), '');
  assert.equal(document.querySelector('[role=dialog]'), null);
  auth.dom.window.close();
});

test('missing and incorrect keys show one manual form; only a valid key is saved', async () => {
  const auth = await setup('http://127.0.0.1:43976/index.html?rk=bad', (_, init) =>
    init.headers['X-Loopra-Key'] === 'valid' ? Response.json({ success: true }) : Response.json({ reason: 'access_key_required' }, { status: 401 }));
  const first = auth.ensureAccess(window.location.origin, true);
  assert.equal(first, auth.ensureAccess(window.location.origin));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(document.querySelectorAll('[role=dialog]').length, 1);
  assert.equal(auth.getAccessKey(window.location.origin), '');
  assert.equal(window.location.search, '');
  const form = document.querySelector('form');
  const input = document.querySelector('input');
  input.value = 'still-wrong';
  form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(document.querySelector('[role=alert]').textContent, /密钥不正确/);
  assert.equal(auth.getAccessKey(window.location.origin), '');
  input.value = 'valid';
  form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await first;
  assert.equal(auth.getAccessKey(window.location.origin), 'valid');
  assert.equal(document.querySelector('[role=dialog]'), null);
  auth.dom.window.close();
});

test('API and SSE fetches carry the key; static and other servers do not receive it', async () => {
  const auth = await setup();
  auth.saveAccessKey(window.location.origin, 'saved');
  await window.fetch('/api/config');
  await window.fetch('/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Request-ID': 'request' }, body: '{}' });
  await window.fetch('/assets/app.js');
  await window.fetch('https://other.example/api/config');
  assert.equal(auth.calls[0].init.headers.get('X-Loopra-Key'), 'saved');
  assert.equal(auth.calls[1].init.headers.get('X-Loopra-Key'), 'saved');
  assert.equal(auth.calls[1].init.headers.get('X-Request-ID'), 'request');
  assert.equal(auth.calls[1].init.body, '{}');
  assert.equal(auth.calls[1].init.redirect, 'error');
  assert.equal(auth.calls[2].init, undefined);
  assert.equal(auth.calls[3].init.headers.has('X-Loopra-Key'), false);
  const image = new URL(auth.authenticatedAssetUrl('/api/pets/test/spritesheet?v=1'));
  assert.equal(image.searchParams.get('rk'), 'saved');
  assert.equal(image.searchParams.get('v'), '1');
  assert.equal(auth.authenticatedAssetUrl('/api/config'), '/api/config');
  auth.dom.window.close();
});

test('desktop requests automatically refresh their key through the bridge', async () => {
  const auth = await setup();
  let key = 'desktop-first';
  window.electronAPI = { loopraWebService: { getAccessKey: async port => port === 43976 ? key : '' } };
  await window.fetch('/api/system/health');
  key = 'desktop-restarted';
  await window.fetch('/api/system/health');
  assert.equal(auth.calls[0].init.headers.get('X-Loopra-Key'), 'desktop-first');
  assert.equal(auth.calls[1].init.headers.get('X-Loopra-Key'), 'desktop-restarted');
  auth.dom.window.close();
});

test('development proxy and direct backend requests share one server credential', async () => {
  const auth = await setup('http://127.0.0.1:3000/');
  auth.setAccessProxy(window.location.origin, 'http://127.0.0.1:4567');
  auth.saveAccessKey('http://127.0.0.1:4567', 'proxy-key');
  await window.fetch('/api/config');
  await window.fetch('http://127.0.0.1:4567/api/config');
  assert.equal(auth.calls[0].init.headers.get('X-Loopra-Key'), 'proxy-key');
  assert.equal(auth.calls[1].init.headers.get('X-Loopra-Key'), 'proxy-key');
  assert.equal(auth.getAccessKey(window.location.origin), 'proxy-key');
  auth.dom.window.close();
});

test('expired API credentials prompt once and replay a denied mutation after validation', async () => {
  const auth = await setup(undefined, (input, init) => {
    const headers = new Headers(init.headers);
    return headers.get('X-Loopra-Key') === 'new-key'
      ? Response.json({ success: true, data: 'ok' })
      : Response.json({ reason: 'access_key_required' }, { status: 401 });
  });
  auth.saveAccessKey(window.location.origin, 'expired');
  const request = window.fetch('/api/config', { method: 'PUT', body: '{"change":true}', headers: { 'Content-Type': 'application/json' } });
  await new Promise(resolve => setTimeout(resolve, 10));
  const form = document.querySelector('form');
  assert.ok(form);
  document.querySelector('input').value = 'new-key';
  form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  const response = await request;
  assert.equal(response.status, 200);
  const replay = auth.calls.at(-1);
  assert.equal(replay.init.method, 'PUT');
  assert.equal(replay.init.body, '{"change":true}');
  assert.equal(replay.init.headers.get('X-Loopra-Key'), 'new-key');
  auth.dom.window.close();
});

test('missing URL and stored credentials require manual entry before mounting', async () => {
  const auth = await setup();
  const pending = auth.ensureAccess(window.location.origin, true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(auth.calls.length, 0);
  assert.ok(document.querySelector('input[type=password]'));
  document.querySelector('input').value = 'manual';
  document.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await pending;
  assert.equal(auth.getAccessKey(window.location.origin), 'manual');
  auth.dom.window.close();
});

test('desktop key IPC only serves bundled pages and known development origins', async () => {
  const main = await readFile(new URL('../../electron/main.cjs', import.meta.url), 'utf8');
  const handler = main.match(/ipcMain.handle\('get_loopra_web_access_key',[\s\S]*?\n\}\)/)[0];
  const trustedSender = main.match(/function isServiceAccessSender\(event\) \{[\s\S]*?\n\}/)[0];
  let getKey;
  const context = vm.createContext({
    ipcMain: { handle: (_, callback) => { getKey = callback; } }, URL, path, fileURLToPath,
    __dirname: path.resolve('dist/main'), isDev: false,
    DESKTOP_CHAT_DEV_RENDERER_ORIGINS: ['http://127.0.0.1:3000', 'http://localhost:3000'],
    serviceAccessKeys: new Map([[4567, 'desktop-owned-key']]),
  });
  vm.runInContext(`${trustedSender}; ${handler}`, context);
  const event = url => ({ senderFrame: { url } });
  const bundled = pathToFileURL(path.resolve('dist/renderer/index.html')).href;
  assert.equal(getKey(event(bundled + '?desktopChatTab=1'), 4567), 'desktop-owned-key');
  assert.equal(getKey(event(bundled), 1234), '');
  for (const url of ['https://evil.example/', 'http://127.0.0.1:3999/', 'http://127.0.0.1:3000/', pathToFileURL(path.resolve('outside.html')).href]) {
    assert.equal(getKey(event(url), 4567), '');
  }
  context.isDev = true;
  assert.equal(getKey(event('http://127.0.0.1:3000/?desktopSplash=1'), 4567), 'desktop-owned-key');
  assert.equal(getKey(event('http://127.0.0.1:3000.evil.example/'), 4567), '');
});

test('a verified external development key is shared with the desktop main process', async () => {
  const auth = await setup('http://127.0.0.1:4567/');
  const supplied = [];
  window.electronAPI = { loopraWebService: { getAccessKey: async () => '', setAccessKey: async (port, key) => { supplied.push([port, key]); return true; } } };
  const pending = auth.ensureAccess(window.location.origin);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(supplied, []);
  document.querySelector('input').value = 'manual-key';
  document.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await pending;
  assert.deepEqual(supplied, [[4567, 'manual-key']]);
  assert.equal(auth.getAccessKey(window.location.origin), 'manual-key');
  auth.dom.window.close();
});

test('the desktop main process verifies external keys before keeping them in memory', async () => {
  const main = await readFile(new URL('../../electron/main.cjs', import.meta.url), 'utf8');
  const handler = main.match(/ipcMain.handle\('set_loopra_web_access_key',[\s\S]*?\n\}\)/)[0];
  let setKey;
  const requests = [];
  const key = 'k'.repeat(43);
  const context = vm.createContext({
    ipcMain: { handle: (_, callback) => { setKey = callback; } }, isDev: true, AbortSignal,
    isServiceAccessSender: event => event.trusted, serviceAccessKeys: new Map(),
    fetch: async (url, init) => { requests.push([url, init]); return Response.json({ success: true, data: { status: 'ok' } }); },
  });
  vm.runInContext(handler, context);
  assert.equal(await setKey({ trusted: false }, 4567, key), false);
  assert.equal(await setKey({ trusted: true }, 51234, key), false);
  assert.equal(await setKey({ trusted: true }, 4567, 'invalid'), false);
  assert.equal(requests.length, 0);
  assert.equal(await setKey({ trusted: true }, 4567, key), true);
  assert.equal(context.serviceAccessKeys.get(4567), key);
  assert.equal(requests[0][1].redirect, 'error');
  context.fetch = async () => Response.json({ reason: 'access_key_required' }, { status: 401 });
  assert.equal(await setKey({ trusted: true }, 4567, 'b'.repeat(43)), false);
  assert.equal(context.serviceAccessKeys.get(4567), key);
  context.isDev = false;
  assert.equal(await setKey({ trusted: true }, 4567, key), false);
});

test('desktop launch gives its child a fresh environment key before readiness probes', async () => {
  const main = await readFile(new URL('../../electron/main.cjs', import.meta.url), 'utf8');
  const start = main.match(/function startLoopraWeb\(port\) \{[\s\S]*?\n\}/)[0];
  for (const isWin of [true, false]) {
    const starts = [];
    let count = 0;
    const context = vm.createContext({
      isWin, path, console: { log() {}, error() {} }, process: { env: { EXISTING: 'kept' } },
      randomBytes: () => ({ toString: () => `generated-${++count}` }), serviceAccessKeys: new Map(),
      getLoopraBinPath: () => ({ binDir: '/runtime/bin', binPath: '/runtime/bin/loopra' }), isLoopraGuiInstalled: () => true,
      spawn: (command, args, options) => { starts.push(options); return { stdout: { on() {} }, stderr: { on() {} }, on() {} }; },
      loopraWebProcess: null,
    });
    vm.runInContext(`${start}; startLoopraWeb(4567); startLoopraWeb(4567);`, context);
    assert.equal(starts[0].env.LOOPRA_ACCESS_KEY, 'generated-1');
    assert.equal(starts[1].env.LOOPRA_ACCESS_KEY, 'generated-2');
    assert.equal(starts[1].env.EXISTING, 'kept');
    assert.equal(context.serviceAccessKeys.get(4567), 'generated-2');
  }
});
