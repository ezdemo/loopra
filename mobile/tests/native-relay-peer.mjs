// Independent WebCrypto responder for the Rust transport tests; no production crypto imports.
import { WebSocketServer } from 'ws';
import { createHash, hkdfSync } from 'node:crypto';
import { spawn } from 'node:child_process';

const code = Buffer.alloc(32, 7).toString('base64url');
const label = 'loopra-relay-e2e/v1';
const server = new WebSocketServer({ host: '127.0.0.1', port: Number(process.argv[2] || 0) });
const routing = Buffer.from(hkdfSync('sha256', Buffer.from(code), Buffer.from(`${label}/routing`), Buffer.alloc(0), 16)).toString('base64url');
let connections = 0;
const desktopMode = process.argv[3] === 'desktop';
let desktop, desktopProcess, phoneId = 0;
const phones = new Map();
server.on('listening', () => {
  const origin = `http://127.0.0.1:${server.address().port}`;
  if (!desktopMode) { console.log(origin); return; }
  desktopProcess = spawn(process.env.LOOPRA_NATIVE_DESKTOP_FIXTURE, [origin], { stdio: ['pipe', 'ignore', 'inherit'] });
  desktopProcess.on('error', error => { console.error(error); process.exit(1); });
  desktopProcess.on('exit', code => { if (code) process.exit(code); });
});
server.on('connection', (socket, request) => {
  if (desktopMode) {
    if (request.url.startsWith('/agent?')) {
      desktop = socket;
      socket.on('message', wire => {
        const frame = JSON.parse(wire.toString());
        if (frame.t === 'register') {
          socket.send(JSON.stringify({t:'registered', proto:1}));
          console.log(`http://127.0.0.1:${server.address().port}`);
        } else if (frame.t === 'wmsg') {
          const phone = phones.get(frame.id);
          if (phone?.readyState === 1) phone.send(frame.b ? Buffer.from(frame.b, 'base64') : frame.s);
        } else if (frame.t === 'wclose') phones.get(frame.id)?.close();
      });
      return;
    }
    if (request.url !== `/c/${routing}/__loopra_e2e__/v1` || !desktop) { socket.close(); return; }
    const id = String(++phoneId);
    phones.set(id, socket);
    desktop.send(JSON.stringify({t:'wopen', id, path:'/__loopra_e2e__/v1'}));
    socket.on('message', (wire, binary) => desktop.send(JSON.stringify({t:'wmsg', id, ...(binary ? {b:wire.toString('base64')} : {s:wire.toString()})})));
    socket.on('close', () => { phones.delete(id); if (desktop.readyState === 1) desktop.send(JSON.stringify({t:'wclose', id})); });
    return;
  }
  const connection = ++connections;
  if (request.url !== `/c/${routing}/__loopra_e2e__/v1`) { socket.close(); return; }
  let keys, confirmed = false, sent = 0n, received = 0n, chain = Promise.resolve();
  const cancelled = new Set();
  const iv = counter => { const nonce = Buffer.alloc(12); nonce.writeBigUInt64BE(counter, 4); return nonce; };
  const send = async frame => {
    const nonce = iv(sent++);
    const body = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, keys.send, Buffer.from(JSON.stringify(frame)));
    socket.send(Buffer.concat([nonce, Buffer.from(body)]));
  };
  const finish = async (id, body, type = 'application/octet-stream') => {
    await send({ t: 'hres', id, status: 200, headers: { 'content-type': type } });
    await send({ t: 'hchunk', id, b: Buffer.from(body).toString('base64url') });
    await send({ t: 'hend', id });
  };
  socket.on('message', (wire, binary) => {
    chain = chain.then(async () => {
      if (!binary) {
        if (process.argv[3] === 'stall') return;
        const hello = JSON.parse(wire.toString());
        if (hello.t === 'ok') {
          if (hello.ci !== keys.ci) throw new Error('initiator authentication');
          confirmed = true; return;
        }
        const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
        const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey));
        const nonce = Buffer.alloc(16, 11);
        const peer = await crypto.subtle.importKey('raw', Buffer.from(hello.epk, 'base64url'), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
        const shared = Buffer.from(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, pair.privateKey, 256));
        const hash = createHash('sha256').update(Buffer.concat([Buffer.from(label), Buffer.from(hello.epk, 'base64url'), publicKey, Buffer.from(hello.n, 'base64url'), nonce])).digest();
        const derive = name => Buffer.from(hkdfSync('sha256', shared, Buffer.from(code), Buffer.concat([Buffer.from(name), hash]), 32));
        keys = {
          receive: await crypto.subtle.importKey('raw', derive('c2s|'), 'AES-GCM', false, ['decrypt']),
          send: await crypto.subtle.importKey('raw', derive('s2c|'), 'AES-GCM', false, ['encrypt']),
          ci: derive('confirm-i|').toString('base64url'),
        };
        socket.send(JSON.stringify({ t: 'hi', epk: publicKey.toString('base64url'), n: nonce.toString('base64url'), cr: derive('confirm-r|').toString('base64url') }));
        return;
      }
      if (!confirmed || !wire.subarray(0, 12).equals(iv(received++))) throw new Error('invalid frame');
      const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: wire.subarray(0, 12) }, keys.receive, wire.subarray(12));
      const frame = JSON.parse(Buffer.from(raw).toString());
      if (frame.t === 'hcancel') { cancelled.add(frame.id); return; }
      if (frame.path === '/api/mobile/handshake' && frame.method === 'HEAD') {
        if (process.argv[3] === 'stale' && connection === 1) return;
        // Match the production Go in-process HTTP writer, which emits HEAD body frames.
        if (process.argv[3] !== 'head-empty') return finish(frame.id, JSON.stringify({success:true, data:{protocol:'loopra-relay', version:1}}), 'application/json');
        await send({t:'hres', id:frame.id, status:200});
        return send({t:'hend', id:frame.id});
      }
      if (frame.path === '/api/mobile/handshake') return finish(frame.id, JSON.stringify({ success: true, data: { protocol: 'loopra-relay', version: 1 } }), 'application/json');
      if (frame.path === '/api/wait') return send({ t: 'hres', id: frame.id, status: 200, headers: { 'content-type': 'text/event-stream' } });
      if (frame.path === '/api/drop') { socket.terminate(); return; }
      if (frame.path.startsWith('/api/cancelled/')) return finish(frame.id, String(cancelled.has(frame.path.slice('/api/cancelled/'.length))));
      if (frame.path === '/api/sse') return finish(frame.id, 'event: content\ndata: 你好\n\nevent: done\ndata: {}\n\n', 'text/event-stream');
      return finish(frame.id, Buffer.from(frame.b || '', 'base64url'));
    }).catch(error => { console.error(error.message); socket.terminate(); });
  });
  socket.on('error', () => {});
});
