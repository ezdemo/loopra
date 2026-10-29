import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../src/access-key.js', import.meta.url), 'utf8');
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
