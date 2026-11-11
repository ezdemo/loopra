import { base64url, clientKeys, concat, counterIV, encode, equal, routingId, unbase64 } from './crypto';
import type { Pairing } from './pairing';
import { openSocket, type SocketFactory, type WireSocket } from './socket';

type Frame = { t: string; id?: string; b?: string; s?: string; status?: number; headers?: Record<string, string>; message?: string };
type Pending = { resolve: (response: Response) => void; reject: (error: Error) => void; body: ReadableStream<Uint8Array>; controller: ReadableStreamDefaultController<Uint8Array>; cleanup: () => void; headers: boolean; ended: boolean; noBody: boolean };
export type RelayState = 'connecting' | 'connected' | 'disconnected' | 'closed';
const asError = (error: unknown) => error instanceof Error ? error : new Error(String(error));

export class RelayTransport {
  readonly native = false;
  state: RelayState = 'disconnected';
  onState?: (state: RelayState, error?: Error) => void;
  private socket?: WireSocket;
  private keys?: Awaited<ReturnType<typeof clientKeys>>;
  private sendCounter = 0n;
  private receiveCounter = 0n;
  private sending = Promise.resolve();
  private receiving = Promise.resolve();
  private pending = new Map<string, Pending>();
  private connecting?: Promise<void>;
  private handshake?: { resolve: () => void; reject: (error: Error) => void; pair: CryptoKeyPair; public: Uint8Array; nonce: Uint8Array };
  private lifetime?: AbortController;

  constructor(readonly pairing: Pairing, private factory: SocketFactory = openSocket) {}
  resume() { /* Browser recovery is driven by visibility and focus in MobileApp. */ }
  private change(state: RelayState, error?: Error) { this.state = state; this.onState?.(state, error); }
  connect(): Promise<void> {
    if (this.state === 'connected') return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.establish().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private async establish() {
    this.change('connecting');
    this.lifetime = new AbortController();
    const signal = this.lifetime.signal;
    const timer = setTimeout(() => this.fail(new Error(this.socket ? '桌面未响应，请确认桌面在线且未重置配对' : '连接中继超时，请检查网络和 HTTPS 域名')), 25000);
    try {
      const route = await routingId(this.pairing.connectCode);
      const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
      const nonce = crypto.getRandomValues(new Uint8Array(16));
      signal.throwIfAborted();
      const url = new URL(this.pairing.relayUrl);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.pathname = `/c/${route}/__loopra_e2e__/v1`;
      let resolve!: () => void; let reject!: (error: Error) => void;
      const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      // A socket can fail before the handshake promise is awaited.
      void ready.catch(() => {});
      this.handshake = { resolve, reject, pair, public: pub, nonce };
      const opening = this.factory(url.href, data => {
        this.receiving = this.receiving.then(() => signal.aborted ? undefined : this.receive(data)).catch(error => { if (!signal.aborted) this.fail(asError(error)); });
      }, () => { if (!signal.aborted) this.fail(new Error('中继已断开，请重新连接')); }, signal);
      void opening.then(socket => { if (signal.aborted) return socket.close(); }).catch(() => {});
      this.socket = await Promise.race([opening, new Promise<never>((_, no) => signal.addEventListener('abort', () => no(signal.reason), { once: true }))]);
      if (signal.aborted) { await this.socket.close(); throw signal.reason; }
      await this.socket.send(JSON.stringify({ t: 'hi', epk: base64url(pub), n: base64url(nonce) }));
      await ready;
    } catch (error) { this.fail(asError(error)); throw error; }
    finally { clearTimeout(timer); }
  }
  private async receive(data: string | Uint8Array) {
    if (this.lifetime?.signal.aborted) return;
    if (this.handshake) {
      if (typeof data !== 'string') throw new Error('桌面握手数据无效');
      const hello: unknown = JSON.parse(data);
      if (!hello || typeof hello !== 'object') throw new Error('桌面握手数据无效');
      const h = hello as Record<string, unknown>;
      if (h.t !== 'hi' || typeof h.epk !== 'string' || typeof h.n !== 'string' || typeof h.cr !== 'string' || h.bin) throw new Error('桌面加密协议不兼容');
      const publicKey = unbase64(h.epk); const nonce = unbase64(h.n);
      if (publicKey.length !== 65 || nonce.length !== 16) throw new Error('桌面握手数据无效');
      const current = this.handshake;
      const keys = await clientKeys(this.pairing.connectCode, current.pair.privateKey, current.public, current.nonce, publicKey, nonce);
      if (this.handshake !== current || this.lifetime?.signal.aborted) return;
      if (!equal(keys.responder, unbase64(h.cr))) throw new Error('桌面身份验证失败，请扫描当前配对码');
      await this.socket?.send(JSON.stringify({ t: 'ok', ci: base64url(keys.initiator) }));
      this.keys = keys; this.handshake = undefined; this.sendCounter = 0n; this.receiveCounter = 0n;
      this.change('connected'); current.resolve(); return;
    }
    if (!this.keys || typeof data === 'string' || data.length < 28 || data.length > 8 << 20) throw new Error('加密帧无效');
    if (!equal(data.subarray(0, 12), counterIV(this.receiveCounter))) throw new Error('加密帧顺序无效');
    const raw = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.subarray(0, 12) }, this.keys.receive, data.subarray(12));
    this.receiveCounter++;
    const value: unknown = JSON.parse(new TextDecoder().decode(raw));
    if (!value || typeof value !== 'object' || typeof (value as Frame).t !== 'string') throw new Error('隧道响应无效');
    const frame = value as Frame;
    const pending = frame.id ? this.pending.get(frame.id) : undefined;
    if (!pending || !frame.id) return;
    if (frame.t === 'hres') {
      if (pending.headers || !Number.isInteger(frame.status) || frame.status! < 200 || frame.status! > 599) throw new Error('HTTP 响应头无效');
      const headers = new Headers();
      for (const [name, value] of Object.entries(frame.headers || {})) {
        if (typeof value !== 'string') throw new Error('HTTP 响应头无效');
        headers.set(name, value);
      }
      pending.headers = true;
      pending.resolve(new Response(pending.noBody || [204, 205, 304].includes(frame.status!) ? null : pending.body, { status: frame.status, headers }));
    } else if (frame.t === 'hchunk') {
      if (!pending.headers || typeof frame.b !== 'string') throw new Error('HTTP 响应顺序无效');
      if ((pending.controller.desiredSize ?? 0) < -(8 << 20)) { this.cancelRequest(frame.id, new Error('响应缓冲区已满，请重试')); return; }
      if (!pending.noBody) pending.controller.enqueue(unbase64(frame.b));
    } else if (frame.t === 'hend') {
      if (!pending.headers) throw new Error('HTTP 响应不完整');
      pending.ended = true; pending.controller.close(); pending.cleanup(); this.pending.delete(frame.id);
    } else if (frame.t === 'herr') this.cancelRequest(frame.id, new Error(frame.message || '桌面请求失败'));
    else throw new Error('未知的 Loopra 响应帧');
  }
  private send(frame: Record<string, unknown>): Promise<void> {
    const lifetime = this.lifetime;
    const task = this.sending.then(async () => {
      if (!this.keys || !this.socket || this.state !== 'connected' || lifetime !== this.lifetime || lifetime?.signal.aborted) throw new Error('尚未连接桌面');
      const iv = counterIV(this.sendCounter++);
      const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.keys.send, encode(JSON.stringify(frame))));
      await this.socket.send(concat(iv, encrypted));
    });
    this.sending = task.catch(error => { if (lifetime === this.lifetime) this.fail(asError(error)); });
    return task;
  }
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (!path.startsWith('/api/') || path.startsWith('//') || path.includes('\\') || path.length > 8192) throw new Error('无效的 Loopra API 路径');
    if (this.state !== 'connected') throw new Error('桌面已断开，请重新连接');
    if (this.pending.size >= 64) throw new Error('请求过多，请稍后重试');
    const request = new Request(`https://loopra.invalid${path}`, init);
    if (request.signal.aborted) throw request.signal.reason;
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > 6 << 20) throw new Error('请求超过 6 MiB，请减少附件大小');
    const id = crypto.randomUUID();
    const headers: Record<string, string> = {};
    for (const name of ['content-type', 'accept', 'x-request-id', 'range']) { const value = request.headers.get(name); if (value) headers[name] = value; }
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel: () => { this.cancelRequest(id, new DOMException('请求已取消', 'AbortError')); } }, { highWaterMark: 256 << 10, size: chunk => chunk.byteLength });
    return new Promise<Response>((resolve, reject) => {
      const abort = () => this.cancelRequest(id, asError(request.signal.reason));
      request.signal.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve, reject, body, controller, cleanup: () => request.signal.removeEventListener('abort', abort), headers: false, ended: false, noBody: request.method === 'HEAD' });
      if (request.signal.aborted) { abort(); return; }
      void this.send({ t: 'hreq', id, path, method: request.method, headers, b: base64url(bytes) }).catch(error => this.cancelRequest(id, asError(error)));
    });
  }
  private cancelRequest(id: string, error: Error) {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id); request.cleanup();
    if (!request.ended) { request.ended = true; try { request.controller.error(error); } catch { /* Reader cancellation already closed it. */ } }
    request.reject(error);
    if (this.state === 'connected') void this.send({ t: 'hcancel', id }).catch(() => {});
  }
  private fail(error: Error) {
    if (this.state === 'closed' || (this.state === 'disconnected' && !this.handshake)) return;
    this.change('disconnected', error); this.lifetime?.abort(error);
    this.handshake?.reject(error); this.handshake = undefined;
    const socket = this.socket; this.socket = undefined; this.keys = undefined;
    for (const id of this.pending.keys()) this.cancelRequest(id, error);
    void socket?.close().catch(() => {});
  }
  close() {
    this.fail(new Error('连接已关闭'));
    this.change('closed');
  }
}
