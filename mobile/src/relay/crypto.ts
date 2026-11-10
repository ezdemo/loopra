const encoder = new TextEncoder();
export const E2E_LABEL = 'loopra-relay-e2e/v1';
export const encode = (value: string) => encoder.encode(value);
export function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function unbase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) throw new Error('中继数据编码无效');
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
export async function derive(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}
export const routingId = async (code: string) => base64url(await derive(encode(code), encode(`${E2E_LABEL}/routing`), new Uint8Array(), 16));
export async function clientKeys(code: string, privateKey: CryptoKey, clientPublic: Uint8Array, clientNonce: Uint8Array, serverPublic: Uint8Array, serverNonce: Uint8Array) {
  const peer = await crypto.subtle.importKey('raw', serverPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256));
  const transcript = new Uint8Array(await crypto.subtle.digest('SHA-256', concat(encode(E2E_LABEL), clientPublic, serverPublic, clientNonce, serverNonce)));
  const key = (label: string) => derive(shared, encode(code), concat(encode(label), transcript), 32);
  const [c2s, s2c, responder, initiator] = await Promise.all(['c2s|', 's2c|', 'confirm-r|', 'confirm-i|'].map(key));
  return {
    send: await crypto.subtle.importKey('raw', c2s, 'AES-GCM', false, ['encrypt']),
    receive: await crypto.subtle.importKey('raw', s2c, 'AES-GCM', false, ['decrypt']),
    responder, initiator,
  };
}
export function equal(a: Uint8Array, b: Uint8Array) {
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}
export function counterIV(counter: bigint) {
  if (counter > 0xffffffffffffffffn) throw new Error('加密会话已过期，请重新连接');
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, counter, false);
  return iv;
}
