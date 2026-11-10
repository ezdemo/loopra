import { invoke, isTauri } from '@tauri-apps/api/core';
import { validatePairing, type Pairing } from './relay/pairing';

const key = 'loopra:mobile-pairing:v1';
export async function loadPairing(): Promise<Pairing | null> {
  const stored: unknown = isTauri() ? await invoke('load_pairing') : JSON.parse(localStorage.getItem(key) || 'null');
  return stored === null ? null : validatePairing(stored);
}
export async function savePairing(pairing: Pairing) {
  const valid = validatePairing(pairing);
  if (isTauri()) await invoke('save_pairing', { pairing: valid });
  else localStorage.setItem(key, JSON.stringify(valid));
}
export async function clearPairing() {
  if (isTauri()) await invoke('clear_pairing');
  else localStorage.removeItem(key);
}
