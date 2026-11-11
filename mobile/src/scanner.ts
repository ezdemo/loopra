import { isTauri } from '@tauri-apps/api/core';

declare global {
  interface Window {
    LoopraQrScanner?: { scan(id: string): void; cancel(id: string): void; result(id: string): string | null };
  }
}

const cancelled = () => new DOMException('已取消扫码', 'AbortError');

export function scanWithNativeBridge(signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const bridge = window.LoopraQrScanner;
    if (!bridge) { reject(new Error('扫码器不可用')); return; }
    const id = crypto.randomUUID();
    let settled = false;
    let poll = 0;
    const finish = (content: string | null, error: string | null) => {
      if (settled) return;
      settled = true;
      if (poll) window.clearInterval(poll);
      signal?.removeEventListener('abort', abort);
      if (error === 'cancelled') reject(cancelled());
      else if (error) reject(new Error(error));
      else if (content) resolve(content);
      else reject(new Error('没有读取到二维码'));
    };
    const check = () => {
      if (settled) return;
      const raw = bridge.result(id);
      if (!raw) return;
      try {
        const result = JSON.parse(raw) as { content?: string | null; error?: string | null };
        finish(result.content || null, result.error || null);
      } catch {
        finish(null, '扫码结果无效');
      }
    };
    const abort = () => {
      bridge.cancel(id);
      finish(null, 'cancelled');
    };
    poll = window.setInterval(check, 250);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else {
      try { bridge.scan(id); }
      catch (error) { finish(null, error instanceof Error ? error.message : String(error)); }
    }
  });
}

export async function scanPairing(signal?: AbortSignal): Promise<string> {
  if (!isTauri()) throw new Error('相机扫码需要在 Android 或 iOS 应用中使用，也可以粘贴配对链接');
  signal?.throwIfAborted();
  if (window.LoopraQrScanner) return scanWithNativeBridge(signal);
  const { scan, cancel, checkPermissions, requestPermissions } = await import('@tauri-apps/plugin-barcode-scanner');
  signal?.throwIfAborted();
  const permission = await checkPermissions();
  if (permission !== 'granted') {
    const next = await requestPermissions();
    if (next !== 'granted') throw new Error('未获得相机权限，请允许相机访问或粘贴配对链接');
  }
  signal?.throwIfAborted();
  await cancel().catch(() => {});
  const abort = () => { void cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  let completed = false;
  try {
    const result = await scan({ windowed: false });
    completed = true;
    signal?.throwIfAborted();
    return result.content;
  } catch (error) {
    if (signal?.aborted || /cancel/i.test(error instanceof Error ? error.message : String(error))) throw cancelled();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!completed) await cancel().catch(() => {});
  }
}
