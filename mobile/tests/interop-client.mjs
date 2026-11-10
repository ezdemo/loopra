import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { load } from './load-source.mjs';

const { RelayTransport } = await load('relay/transport.ts');
const { parsePairingLink, pairingOrigin } = await load('relay/pairing.ts');
const { relayFetch } = await load('relay/fetch.ts');
const { LoopraClient } = await load(new URL('../../web/src/backend.ts', import.meta.url).href);
const pairing = parsePairingLink(process.env.LOOPRA_MOBILE_TEST_PAIRING);
const factory = (url, receive, closed, signal) => new Promise((resolve, reject) => {
  const socket = new WebSocket(url);
  signal.addEventListener('abort', () => { socket.close(); reject(signal.reason); }, { once: true });
  socket.on('message', (data, binary) => receive(binary ? new Uint8Array(data) : data.toString()));
  socket.on('error', reject);
  socket.on('close', closed);
  socket.once('open', () => resolve({
    send: async data => { socket.send(data); },
    close: async () => { socket.close(); },
  }));
});
const transport = new RelayTransport(pairing, factory);
const original = globalThis.fetch;
try {
  await transport.connect();
  const origin = await pairingOrigin(pairing);
  globalThis.fetch = relayFetch(transport, origin, original);
  const api = new LoopraClient(origin);
  const handshake = await api.request('/mobile/handshake');
  assert.equal(handshake.protocol, 'loopra-relay');
  assert.equal(handshake.version, 1);
  const [health, workspaces, config] = await Promise.all([api.request('/system/health'), api.request('/workspaces'), api.request('/config')]);
  assert.equal(health.status, 'ok'); assert.ok(Array.isArray(workspaces)); assert.ok(config);
  const binary = await transport.fetch('/api/fixture/binary');
  assert.deepEqual([...new Uint8Array(await binary.arrayBuffer())], [0, 1, 127, 128, 255]);
  const events = [];
  await api.stream({ message: 'mobile hello', sessionName: 'mobile-interop', requestId: 'mobile-interop-turn' }, event => events.push(event), AbortSignal.timeout(15000));
  assert.ok(events.some(event => event.type === 'complete'));
  assert.match(JSON.stringify(events), /你好/);
  const history = await api.request('/agent/history?sessionName=mobile-interop');
  assert.match(JSON.stringify(history), /Mobile/);
  const sessions = await api.request('/sessions');
  assert.ok(sessions.some(session => session.name === 'mobile-interop'));
  let firstToken;
  const started = new Promise(resolve => { firstToken = resolve; });
  const activeTurn = api.stream({ message: 'continue working', sessionName: 'mobile-interop', requestId: 'mobile-long-turn' }, event => { if (event.type === 'content') firstToken(); }, AbortSignal.timeout(15000));
  void activeTurn.catch(() => {});
  await started;
  transport.close();
  await assert.rejects(activeTurn);
  await transport.connect();
  const status = await api.request('/agent/session-status?sessionName=mobile-interop');
  assert.equal(status.running, true);
  assert.equal(status.requestId, 'mobile-long-turn');
  await assert.rejects(api.request('/chat/abort', 'POST', { sessionName: 'mobile-interop', requestId: 'obsolete-turn' }), error => error.reason === 'chat_run_changed');
  assert.equal((await api.request('/agent/session-status?sessionName=mobile-interop')).running, true);
  await api.request('/chat/abort', 'POST', { sessionName: 'mobile-interop', requestId: status.requestId });
  const abort = new AbortController();
  const waiting = await transport.fetch('/api/fixture/wait', { signal: abort.signal });
  const reading = waiting.text(); abort.abort();
  await assert.rejects(reading, { name: 'AbortError' });
  assert.equal((await api.request('/system/health')).status, 'ok');
  console.log('PASS: native LoopraClient, pairing, E2E, HTTP, binary, SSE, persisted history, disconnect keeps turn alive, reconnect, stale abort rejection, cancellation');
} finally { globalThis.fetch = original; transport.close(); }
