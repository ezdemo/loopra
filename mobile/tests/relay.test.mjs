import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './load-source.mjs';

const { RelayTransport } = await load('relay/transport.ts');
const { normalizeInstanceName, parsePairingLink, validatePairing, pairingOrigin } = await load('relay/pairing.ts');
const { relayFetch } = await load('relay/fetch.ts');
const { derive, encode, concat, base64url, unbase64, counterIV, E2E_LABEL } = await load('relay/crypto.ts');
const pairing = { relayUrl: 'https://relay.example', connectCode: base64url(new Uint8Array(32).fill(7)), version: 1 };
const link = (extra = {}) => 'loopra://connect?' + new URLSearchParams({ u: pairing.relayUrl, k: pairing.connectCode, e2e: '1', v: '1', ...extra });

// The fake is an independent responder. Production interoperability is also
// exercised against the Go desktop and the actual alma-relay process.
function responder(onRequest, options = {}) {
  let receive, closed, keys, sendCounter = 0n, receiveCounter = 0n;
  const events = [];
  const waiting = new Map();
  const factory = async (url, input, close) => {
    assert.match(url, /\/c\/[A-Za-z0-9_-]+\/__loopra_e2e__\/v1$/);
    receive = input; closed = close;
    return {
      close: async () => { events.push({ t: 'closed' }); },
      send: async data => {
        if (typeof data === 'string') {
          const h = JSON.parse(data);
          if (h.t === 'ok') { assert.equal(h.ci, base64url(keys.ci)); return; }
          assert.equal(h.t, 'hi');
          const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
          const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
          const nonce = new Uint8Array(16).fill(11);
          const clientPublic = unbase64(h.epk);
          const peer = await crypto.subtle.importKey('raw', clientPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
          const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, pair.privateKey, 256));
          const transcript = new Uint8Array(await crypto.subtle.digest('SHA-256', concat(encode(E2E_LABEL), clientPublic, pub, unbase64(h.n), nonce)));
          const key = label => derive(shared, encode(pairing.connectCode), concat(encode(label), transcript), 32);
          const [c2s, s2c, cr, ci] = await Promise.all(['c2s|', 's2c|', 'confirm-r|', 'confirm-i|'].map(key));
          keys = { receive: await crypto.subtle.importKey('raw', c2s, 'AES-GCM', false, ['decrypt']), send: await crypto.subtle.importKey('raw', s2c, 'AES-GCM', false, ['encrypt']), ci };
          receive(JSON.stringify({ t: 'hi', epk: base64url(pub), n: base64url(nonce), cr: base64url(options.wrongIdentity ? new Uint8Array(32) : cr) }));
          return;
        }
        assert.deepEqual(data.slice(0, 12), counterIV(receiveCounter++));
        const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12) }, keys.receive, data.slice(12));
        const frame = JSON.parse(new TextDecoder().decode(raw));
        events.push(frame);
        waiting.get(frame.t)?.(frame);
        if (frame.t === 'hreq') void onRequest(frame, send).catch(() => closed());
      },
    };
  };
  let sending = Promise.resolve();
  const send = frame => {
    const operation = sending.then(async () => {
      const iv = counterIV(sendCounter++);
      const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keys.send, encode(JSON.stringify(frame))));
      receive(concat(iv, encrypted));
    });
    sending = operation;
    return operation;
  };
  return { factory, events, waitFor: type => new Promise(resolve => waiting.set(type, resolve)), drop: () => closed(), tamper: () => receive(new Uint8Array(28)), send };
}
const finish = async (request, send, text = 'ok') => {
  await send({ t: 'hres', id: request.id, status: 200, headers: { 'content-type': 'text/plain' } });
  await send({ t: 'hchunk', id: request.id, b: base64url(encode(text)) });
  await send({ t: 'hend', id: request.id });
};

test('pairing accepts only versioned Loopra HTTPS origins and canonical secrets', async () => {
  assert.deepEqual(parsePairingLink(link()), pairing);
  for (const bad of [link({ v: '2' }), link({ e2e: '0' }), link({ u: 'http://relay.example' }), link({ u: 'https://relay.example/path' }), link({ k: 'short' }), link() + '&v=1', link().replace('loopra:', 'alma:')]) assert.throws(() => parsePairingLink(bad));
  assert.throws(() => validatePairing({ ...pairing, relayUrl: 'https://user@relay.example' }));
  assert.deepEqual(validatePairing({ ...pairing, displayName: '  我的 主机\n' }), { ...pairing, displayName: '我的 主机' });
  assert.equal(normalizeInstanceName('   '), undefined);
  assert.equal(normalizeInstanceName('x'.repeat(60)).length, 40);
  assert.notEqual(await pairingOrigin(pairing), await pairingOrigin({ ...pairing, connectCode: base64url(new Uint8Array(32).fill(8)) }));
});

test('encrypted HTTP preserves concurrent response identities and request bodies', async () => {
  const peer = responder(async (request, send) => finish(request, send, new TextDecoder().decode(unbase64(request.b)) || request.path));
  const transport = new RelayTransport(pairing, peer.factory);
  try {
    await transport.connect();
    const responses = await Promise.all([transport.fetch('/api/one'), transport.fetch('/api/two', { method: 'POST', body: '你好' })]);
    assert.deepEqual(await Promise.all(responses.map(r => r.text())), ['/api/one', '你好']);
    assert.notEqual(peer.events[0].id, peer.events[1].id);
    assert.equal(peer.events[1].method, 'POST');
  } finally { transport.close(); }
});

test('SSE headers and first chunk arrive while the response is still running', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const peer = responder(async (request, send) => {
    await send({ t: 'hres', id: request.id, status: 200, headers: { 'content-type': 'text/event-stream' } });
    await send({ t: 'hchunk', id: request.id, b: base64url(encode('event: content\ndata: 你好\n\n')) });
    await gate;
    await send({ t: 'hchunk', id: request.id, b: base64url(encode('event: done\ndata: {}\n\n')) });
    await send({ t: 'hend', id: request.id });
  });
  const transport = new RelayTransport(pairing, peer.factory);
  try {
    await transport.connect();
    const response = await transport.fetch('/api/chat/stream', { method: 'POST' });
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const reader = response.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /你好/);
    release();
    assert.match(new TextDecoder().decode((await reader.read()).value), /done/);
    assert.equal((await reader.read()).done, true);
  } finally { release(); transport.close(); }
});

test('abort sends hcancel and disconnect rejects in-flight response bodies', async () => {
  const peer = responder(async (request, send) => { await send({ t: 'hres', id: request.id, status: 200 }); });
  const transport = new RelayTransport(pairing, peer.factory);
  try {
    await transport.connect();
    const controller = new AbortController();
    const response = await transport.fetch('/api/fixture', { signal: controller.signal });
    const reading = response.text();
    const canceled = peer.waitFor('hcancel');
    controller.abort();
    await assert.rejects(reading, { name: 'AbortError' });
    await canceled;
    assert.ok(peer.events.some(event => event.t === 'hcancel'));
    const second = await transport.fetch('/api/fixture');
    const secondReading = second.text(); peer.drop();
    await assert.rejects(secondReading, /断开/);
  } finally { transport.close(); }
});

test('wrong desktop confirmation and tampered encrypted frames fail closed', async () => {
  const wrong = new RelayTransport(pairing, responder(async () => {}, { wrongIdentity: true }).factory);
  await assert.rejects(wrong.connect(), /身份验证失败/);
  wrong.close();
  const peer = responder(async () => {});
  const transport = new RelayTransport(pairing, peer.factory);
  await transport.connect();
  const request = transport.fetch('/api/fixture');
  peer.tamper();
  await assert.rejects(request);
  assert.equal(transport.state, 'disconnected');
  transport.close();
});

test('closing during socket setup rejects promptly and closes a late socket', async () => {
  let resolve, closed = false;
  const transport = new RelayTransport(pairing, async () => new Promise(yes => { resolve = yes; }));
  const connecting = transport.connect();
  while (!resolve) await new Promise(yes => setImmediate(yes));
  transport.close();
  await assert.rejects(connecting);
  resolve({ send: async () => {}, close: async () => { closed = true; } });
  await new Promise(yes => setImmediate(yes));
  assert.equal(closed, true);
});

test('fetch adapter isolates the paired virtual origin and preserves redirects', async () => {
  const calls = [];
  const transport = { async fetch(path, init) { calls.push({ path, init }); return path === '/api/start' ? new Response(null, { status: 307, headers: { location: '/api/end' } }) : new Response('complete'); } };
  let fallback = false;
  const origin = 'https://fixture.loopra.invalid';
  const fetch = relayFetch(transport, origin, async () => { fallback = true; return new Response('asset'); });
  assert.equal(await (await fetch(origin + '/api/start', { method: 'POST', body: 'body' })).text(), 'complete');
  assert.deepEqual(calls.map(call => call.path), ['/api/start', '/api/end']);
  assert.equal(calls[1].init.method, 'POST');
  await fetch('https://example.org/asset'); assert.equal(fallback, true);
});
