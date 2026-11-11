import { Channel, invoke } from '@tauri-apps/api/core';
import type { Pairing } from './pairing';
import type { RelayState } from './transport';

type StateEvent = { state: RelayState; error?: string; revision?: number };
type ResponseHead = { status: number; headers: Record<string, string> };
type Bridge = {
  invoke: <T>(command: string, args: Record<string, unknown>) => Promise<T>;
  channel: (receive: (event: StateEvent) => void) => unknown;
};
const bridge: Bridge = {
  invoke,
  channel: receive => {
    const channel = new Channel<StateEvent>();
    channel.onmessage = receive;
    return channel;
  },
};
const asError = (value: unknown) => value instanceof Error ? value : new Error(String(value));

// Owns only fetch/ReadableStream adaptation. Rust owns the connection and all protocol state.
export class NativeRelayTransport {
  readonly native = true;
  state: RelayState = 'disconnected';
  origin?: string;
  onState?: (state: RelayState, error?: Error) => void;
  private readonly connectionId = crypto.randomUUID();
  private opening?: Promise<void>;
  private settleReady?: { resolve: () => void; reject: (error: Error) => void };
  private requests = new Map<string, (error: Error) => void>();
  private stateRevision = 0;
  private resuming?: Promise<void>;

  constructor(readonly pairing: Pairing, private readonly ipc: Bridge = bridge) {}

  private receiveState(event: StateEvent) {
    if (event.revision !== undefined) {
      if (event.revision <= this.stateRevision) return;
      this.stateRevision = event.revision;
    }
    this.change(event.state, event.error ? new Error(event.error) : undefined);
  }
  syncState() {
    if (this.state === 'closed' || !this.opening) return;
    void this.ipc.invoke<StateEvent>('relay_status', { connectionId: this.connectionId })
      .then(event => this.receiveState(event))
      .catch(error => this.change('disconnected', asError(error)));
  }

  private change(state: RelayState, error?: Error) {
    if (this.state === 'closed') return;
    this.state = state;
    if (state === 'connected') this.settleReady?.resolve();
    if (state === 'closed') this.settleReady?.reject(error || new Error('连接已关闭'));
    if (state === 'disconnected' || state === 'closed') {
      for (const fail of [...this.requests.values()]) fail(error || new Error('中继已断开'));
    }
    this.onState?.(state, error);
  }
  connect(): Promise<void> {
    if (this.state === 'closed') return Promise.reject(new Error('连接已关闭'));
    if (this.opening) return this.opening;
    this.change('connecting');
    const ready = new Promise<void>((resolve, reject) => { this.settleReady = { resolve, reject }; });
    void ready.catch(() => {});
    const onState = this.ipc.channel(event => this.receiveState(event));
    this.opening = (async () => {
      try {
        const opened = this.ipc.invoke<string>('relay_open', { connectionId: this.connectionId, pairing: this.pairing, onState }).then(origin => {
          if (this.state === 'closed') {
            void this.ipc.invoke('relay_close', { connectionId: this.connectionId }).catch(() => {});
            throw new Error('连接已关闭');
          }
          this.origin = origin;
        });
        await Promise.all([opened, ready]);
      } catch (error) {
        this.change('closed', asError(error));
        await this.ipc.invoke('relay_close', { connectionId: this.connectionId }).catch(() => {});
        throw asError(error);
      }
    })();
    return this.opening;
  }
  resume(): Promise<void> {
    if (this.resuming) return this.resuming;
    if (this.state === 'closed' || !this.opening) return Promise.reject(new Error('连接已关闭'));
    this.resuming = this.ipc.invoke<void>('relay_resume', { connectionId: this.connectionId })
      .catch(error => { throw asError(error); })
      .finally(() => { this.resuming = undefined; });
    return this.resuming;
  }
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (!path.startsWith('/api/') || path.includes('\\') || path.length > 8192) throw new Error('无效的 Loopra API 路径');
    if (this.state !== 'connected') throw new Error('桌面已断开，正在重新连接');
    const request = new Request(`https://loopra.invalid${path}`, init);
    request.signal.throwIfAborted();
    const body = new Uint8Array(await request.arrayBuffer());
    request.signal.throwIfAborted();
    if (body.byteLength > 6 << 20) throw new Error('请求超过 6 MiB，请减少附件大小');
    const requestId = crypto.randomUUID();
    const args = { connectionId: this.connectionId, requestId };
    const headers: Record<string, string> = {};
    for (const name of ['content-type', 'accept', 'x-request-id', 'range']) {
      const value = request.headers.get(name);
      if (value) headers[name] = value;
    }
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let ended = false;
    let rejectHeaders!: (error: Error) => void;
    const interrupted = new Promise<never>((_, reject) => { rejectHeaders = reject; });
    const cleanup = () => { this.requests.delete(requestId); request.signal.removeEventListener('abort', abort); };
    const cancel = () => this.ipc.invoke<void>('relay_cancel', args).catch(() => {});
    const fail = (error: Error) => {
      if (ended) return;
      ended = true;
      cleanup();
      rejectHeaders(error);
      stream?.error(error);
      void cancel();
    };
    const abort = () => fail(asError(request.signal.reason));
    this.requests.set(requestId, fail);
    request.signal.addEventListener('abort', abort, { once: true });
    try {
      if (request.signal.aborted) abort();
      const head = await Promise.race([
        this.ipc.invoke<ResponseHead>('relay_request', { connectionId: this.connectionId, request: { id: requestId, path, method: request.method, headers, body: Array.from(body) } }),
        interrupted,
      ]);
      if (ended) throw request.signal.reason || new Error('请求已取消');
      if (request.method === 'HEAD' || [204, 205, 304].includes(head.status)) {
        ended = true; cleanup(); void cancel();
        return new Response(null, head);
      }
      const responseBody = new ReadableStream<Uint8Array>({
        start: controller => { stream = controller; },
        pull: async controller => {
          try {
            const raw = await this.ipc.invoke<ArrayBuffer>('relay_read', args);
            if (ended) return;
            const chunk = new Uint8Array(raw);
            if (chunk.byteLength) controller.enqueue(chunk);
            else { ended = true; cleanup(); controller.close(); }
          } catch (error) { fail(asError(error)); }
        },
        cancel: () => {
          if (ended) return;
          ended = true; cleanup();
          return cancel();
        },
      }, { highWaterMark: 64 << 10, size: chunk => chunk.byteLength });
      return new Response(responseBody, head);
    } catch (error) { fail(asError(error)); throw asError(error); }
  }
  close() {
    if (this.state === 'closed') return;
    this.change('closed', new Error('连接已关闭'));
    void this.ipc.invoke('relay_close', { connectionId: this.connectionId }).catch(() => {});
  }
}
