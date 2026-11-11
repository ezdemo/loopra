import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load } from './load-source.mjs';

const { NativeRelayTransport } = await load('relay/native.ts');
const pairing = { relayUrl: 'https://relay.example', connectCode: 'fixture', version: 1 };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(handle = async () => {}) {
  const calls = [];
  let state;
  const ipc = {
    channel: callback => { state = callback; return 'channel'; },
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === 'relay_open') { queueMicrotask(() => state({ state: 'connected' })); return 'https://fixture.loopra.invalid'; }
      if (command === 'relay_request') return { status: 200, headers: { 'content-type': 'application/octet-stream' } };
      if (command === 'relay_read') return handle(args.requestId);
    },
  };
  return { calls, ipc, state: value => state(value) };
}

test('native fetch keeps response identities, binary bytes and pulls bounded chunks', async () => {
  const counts = new Map();
  const peer = fixture(async id => {
    const count = counts.get(id) || 0;
    counts.set(id, count + 1);
    return count === 0 ? new Uint8Array([0, 1, 127, 128, 255]).buffer : new ArrayBuffer(0);
  });
  const transport = new NativeRelayTransport(pairing, peer.ipc);
  try {
    await transport.connect();
    assert.equal(transport.origin, 'https://fixture.loopra.invalid');
    const responses = await Promise.all([transport.fetch('/api/one'), transport.fetch('/api/two', { method: 'POST', body: '你好', headers: { cookie: 'never forward', 'content-type': 'text/plain' } })]);
    assert.deepEqual(await Promise.all(responses.map(async response => [...new Uint8Array(await response.arrayBuffer())])), [[0, 1, 127, 128, 255], [0, 1, 127, 128, 255]]);
    const requests = peer.calls.filter(call => call.command === 'relay_request').map(call => call.args.request);
    assert.notEqual(requests[0].id, requests[1].id);
    assert.deepEqual(requests[1].body, [...new TextEncoder().encode('你好')]);
    assert.equal(requests[1].headers.cookie, undefined);
    assert.equal(counts.size, 2);
  } finally { transport.close(); }
});

test('native reader cancellation and abort release remote requests promptly', async () => {
  let release;
  const peer = fixture(() => new Promise(resolve => { release = resolve; }));
  const transport = new NativeRelayTransport(pairing, peer.ipc);
  try {
    await transport.connect();
    const controller = new AbortController();
    const response = await transport.fetch('/api/wait', { signal: controller.signal });
    const reading = response.text();
    controller.abort();
    await assert.rejects(reading, { name: 'AbortError' });
    assert.ok(peer.calls.some(call => call.command === 'relay_cancel'));
    release(new ArrayBuffer(0));
    const next = await transport.fetch('/api/another');
    await next.body.cancel();
    assert.equal(peer.calls.filter(call => call.command === 'relay_cancel').length, 2);
    release(new ArrayBuffer(0));
  } finally { transport.close(); }
});

test('native disconnect fails streams; reconnect does not reopen or replay a write', async () => {
  const peer = fixture(() => new Promise(() => {}));
  const transport = new NativeRelayTransport(pairing, peer.ipc);
  try {
    await transport.connect();
    const response = await transport.fetch('/api/chat/stream', { method: 'POST', body: 'send once' });
    const reading = response.text();
    peer.state({ state: 'disconnected', error: 'offline' });
    await assert.rejects(reading, /offline/);
    await assert.rejects(transport.fetch('/api/health'), /断开/);
    peer.state({ state: 'connecting' });
    peer.state({ state: 'connected' });
    transport.resume();
    await tick();
    assert.equal(peer.calls.filter(call => call.command === 'relay_open').length, 1);
    assert.equal(peer.calls.filter(call => call.command === 'relay_request').length, 1);
    assert.equal(peer.calls.filter(call => call.command === 'relay_resume').length, 1);
  } finally { transport.close(); }
});

test('native startup retries remain in Rust and closing during setup rejects promptly', async () => {
  let notify, finish;
  const calls = [];
  const transport = new NativeRelayTransport(pairing, {
    channel: callback => { notify = callback; return 'channel'; },
    invoke: async command => { calls.push(command); if (command === 'relay_open') return new Promise(resolve => { finish = resolve; }); },
  });
  const connecting = transport.connect();
  void connecting.catch(() => {});
  notify({ state: 'disconnected', error: 'offline' });
  notify({ state: 'connecting' });
  assert.equal(calls.filter(call => call === 'relay_open').length, 1);
  transport.close();
  await assert.rejects(connecting, /关闭/);
  finish('https://fixture.loopra.invalid');
  await tick();
  notify({ state: 'connected' });
  assert.equal(transport.state, 'closed');
  assert.ok(calls.includes('relay_close'));
});

test('native abort before headers does not wait for the IPC request to finish', async () => {
  const peer = fixture();
  const invoke = peer.ipc.invoke;
  let finish;
  peer.ipc.invoke = (command, args) => command === 'relay_request' ? new Promise(resolve => { finish = resolve; }) : invoke(command, args);
  const transport = new NativeRelayTransport(pairing, peer.ipc);
  try {
    await transport.connect();
    const controller = new AbortController();
    const response = transport.fetch('/api/wait', { signal: controller.signal });
    while (!finish) await tick();
    controller.abort();
    await assert.rejects(response, { name: 'AbortError' });
    finish({ status: 200, headers: {} });
    assert.ok(peer.calls.some(call => call.command === 'relay_cancel'));
  } finally { transport.close(); }
});

test('foreground state sync ignores delayed snapshots without interrupting healthy streams', async () => {
  const peer = fixture(() => new Promise(() => {}));
  const original = peer.ipc.invoke;
  let snapshot;
  peer.ipc.invoke = (command, args) => command === 'relay_status' ? new Promise(resolve => { snapshot = resolve; }) : original(command, args);
  const transport = new NativeRelayTransport(pairing, peer.ipc);
  try {
    await transport.connect();
    peer.state({state:'connected', revision:2});
    const response = await transport.fetch('/api/wait');
    transport.syncState();
    peer.state({state:'connected', revision:4});
    snapshot({state:'disconnected', revision:3, error:'stale snapshot'});
    await tick();
    assert.equal(transport.state, 'connected');
    assert.equal(peer.calls.filter(call => call.command === 'relay_open').length, 1);
    assert.equal(peer.calls.filter(call => call.command === 'relay_cancel').length, 0);
    await response.body.cancel();
  } finally { transport.close(); }
});

test('manual reconnect waits for native confirmation and coalesces repeated taps', async () => {
  const peer = fixture();
  const original = peer.ipc.invoke;
  let confirm, checks = 0;
  peer.ipc.invoke = (command, args) => {
    if (command === 'relay_resume') { checks++; return new Promise(resolve => { confirm = resolve; }); }
    return original(command, args);
  };
  const transport = new NativeRelayTransport(pairing, peer.ipc);
  try {
    await transport.connect();
    const first = transport.resume();
    assert.equal(transport.resume(), first);
    let finished = false;
    void first.then(() => { finished = true; });
    await tick();
    assert.equal(finished, false);
    assert.equal(checks, 1);
    confirm();
    await first;
    assert.equal(transport.state, 'connected');
    const next = transport.resume();
    assert.equal(checks, 2);
    confirm(); await next;
  } finally { transport.close(); }
});
