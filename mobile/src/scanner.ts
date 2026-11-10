import { isTauri } from '@tauri-apps/api/core';

export async function scanPairing(signal?: AbortSignal): Promise<string> {
  if (!isTauri()) throw new Error('相机扫码需要在 Android 或 iOS 应用中使用，也可以粘贴配对链接');
  const { scan, cancel, Format, checkPermissions, requestPermissions } = await import('@tauri-apps/plugin-barcode-scanner');
  signal?.throwIfAborted();
  const permission = await checkPermissions();
  if (permission !== 'granted') {
    const next = await requestPermissions();
    if (next !== 'granted') throw new Error('未获得相机权限，请允许相机访问或粘贴配对链接');
  }
  signal?.throwIfAborted();
  const abort = () => { void cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const result = await scan({ formats: [Format.QRCode], windowed: false });
    signal?.throwIfAborted();
    return result.content;
  } finally { signal?.removeEventListener('abort', abort); }
}
