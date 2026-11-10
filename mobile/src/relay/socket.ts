import { isTauri } from '@tauri-apps/api/core';

export type WireSocket = { send: (data: string | Uint8Array) => Promise<void>; close: () => Promise<void> };
export type SocketFactory = (url: string, receive: (data: string | Uint8Array) => void, closed: () => void, signal: AbortSignal) => Promise<WireSocket>;

export const openSocket: SocketFactory = async (url, receive, closed, signal) => {
  signal.throwIfAborted();
  if (isTauri()) {
    const { default: NativeWebSocket } = await import('@tauri-apps/plugin-websocket');
    const socket = await NativeWebSocket.connect(url);
    if (signal.aborted) { await socket.disconnect(); throw signal.reason; }
    const remove = socket.addListener(message => {
      if (message.type === 'Text') receive(message.data);
      else if (message.type === 'Binary') receive(new Uint8Array(message.data));
      else if (message.type === 'Close') closed();
    });
    return { send: data => socket.send(typeof data === 'string' ? data : Array.from(data)), close: async () => { remove(); await socket.disconnect(); } };
  }
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    const abort = () => { socket.close(); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    socket.addEventListener('open', () => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) { abort(); return; }
      resolve({ send: async data => { if (socket.readyState !== WebSocket.OPEN) throw new Error('中继已断开'); socket.send(data); }, close: async () => { socket.close(); } });
    }, { once: true });
    socket.addEventListener('message', event => receive(typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer)));
    socket.addEventListener('close', () => { signal.removeEventListener('abort', abort); reject(new Error('中继连接关闭')); closed(); });
    socket.addEventListener('error', () => { signal.removeEventListener('abort', abort); reject(new Error('无法连接中继，请检查 HTTPS 地址和网络')); closed(); });
  });
};
