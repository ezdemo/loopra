import { base64url, unbase64 } from './crypto';

export type Pairing = { relayUrl: string; connectCode: string; version: 1; displayName?: string };
export function normalizeInstanceName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const compact = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const name = Array.from(compact).slice(0, 40).join('');
  return name || undefined;
}
export function validatePairing(value: unknown): Pairing {
  if (!value || typeof value !== 'object') throw new Error('配对信息无效');
  const fields = value as Record<string, unknown>;
  if (fields.version !== 1) throw new Error('不支持这个配对协议版本，请更新 Loopra');
  if (typeof fields.relayUrl !== 'string' || typeof fields.connectCode !== 'string') throw new Error('配对信息不完整');
  const relay = new URL(fields.relayUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(relay.hostname);
  if ((relay.protocol !== 'https:' && !(relay.protocol === 'http:' && local)) || relay.username || relay.password || relay.pathname !== '/' || relay.search || relay.hash) throw new Error('中继地址需要有效的 HTTPS 域名');
  const bytes = unbase64(fields.connectCode);
  if (bytes.length !== 32 || base64url(bytes) !== fields.connectCode) throw new Error('配对码无效');
  const displayName = normalizeInstanceName(fields.displayName);
  return { relayUrl: relay.origin, connectCode: fields.connectCode, version: 1, ...(displayName ? { displayName } : {}) };
}
export function parsePairingLink(input: string): Pairing {
  if (input.length > 4096) throw new Error('配对链接过长');
  const link = new URL(input.trim());
  if (link.protocol !== 'loopra:' || link.hostname !== 'connect' || link.pathname || link.hash || link.searchParams.get('e2e') !== '1') throw new Error('请使用 Loopra 桌面端的配对二维码或链接');
  for (const name of ['u', 'k', 'v', 'e2e']) if (link.searchParams.getAll(name).length !== 1) throw new Error('配对链接无效');
  return validatePairing({ relayUrl: link.searchParams.get('u'), connectCode: link.searchParams.get('k'), version: Number(link.searchParams.get('v')) });
}
export async function pairingOrigin(pairing: Pairing): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pairing.connectCode)));
  return `https://${Array.from(hash.slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('')}.loopra.invalid`;
}
