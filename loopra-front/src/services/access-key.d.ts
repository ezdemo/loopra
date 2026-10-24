export function accessOrigin(server: string): string;
export function setAccessProxy(proxy: string, server: string): void;
export function getAccessKey(server: string): string;
export function saveAccessKey(server: string, key: string): void;
export function getAccessHeaders(server: string): Promise<Record<string, string>>;
export function authenticatedAssetUrl(value: string): string;
export function ensureAccess(server: string, usePageKey?: boolean): Promise<void>;
export function installAccessKeyProtocol(): void;
declare global {
  interface Window { loopraAssetUrl?: (url: string) => string }
}
