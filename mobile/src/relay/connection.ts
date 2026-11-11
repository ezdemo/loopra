import { isTauri } from '@tauri-apps/api/core';
import type { Pairing } from './pairing';
import type { RelayState } from './transport';
import { NativeRelayTransport } from './native';
import { RelayTransport } from './transport';

export interface RelayConnection {
  readonly native: boolean;
  readonly state: RelayState;
  readonly origin?: string;
  onState?: (state: RelayState, error?: Error) => void;
  connect(): Promise<void>;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  resume(): void | Promise<void>;
  syncState?(): void;
  close(): void;
}

export function createRelayTransport(pairing: Pairing): RelayConnection {
  return isTauri() ? new NativeRelayTransport(pairing) : new RelayTransport(pairing);
}
