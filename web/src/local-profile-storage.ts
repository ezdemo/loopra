import type { LocalProfile } from './local-profile';

export const PROFILE_KEY = 'loopra:local-profile';
type ProfileBridge = { get: () => Promise<LocalProfile | null>; set: (profile: LocalProfile) => Promise<unknown> };
type ProfileStorage = Pick<Storage, 'setItem'>;

function missingProfileHandler(error: unknown): boolean {
  return error instanceof Error && /No handler registered for ['"]?local-profile-(?:get|set)/i.test(error.message);
}

export async function loadDesktopProfile(bridge: ProfileBridge, cached: LocalProfile): Promise<LocalProfile> {
  try {
    const saved = await bridge.get();
    // A missing desktop file can contain a profile saved before the main process restarted.
    if (saved !== null) return saved;
    if (cached.nickname || cached.avatar) await bridge.set(cached);
    return cached;
  } catch (error) {
    if (missingProfileHandler(error)) return cached;
    throw error;
  }
}

export async function persistLocalProfile(profile: LocalProfile, storage: ProfileStorage, bridge?: ProfileBridge): Promise<void> {
  if (bridge) {
    try {
      await bridge.set(profile);
      // Keep a cache for development reloads; a cache failure must not undo a successful file save.
      try { storage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch { /* Desktop file is authoritative. */ }
      return;
    } catch (error) {
      // Vite can reload a new preload while Electron still runs the old main process.
      if (!missingProfileHandler(error)) throw error;
    }
  }
  storage.setItem(PROFILE_KEY, JSON.stringify(profile));
}

export function profileSaveError(error: unknown, english: boolean): string {
  const detail = error instanceof Error ? error.message : String(error || '');
  const name = error instanceof Error ? error.name : '';
  if (name === 'QuotaExceededError') return english ? 'Local storage is full. Try a smaller avatar.' : '本地存储空间不足，请尝试更小的头像';
  if (name === 'SecurityError') return english ? 'Local storage is blocked. Your profile could not be saved.' : '本地存储被阻止，无法保存个人资料';
  if (/EACCES|EPERM|access.*denied/i.test(detail)) return english ? 'Unable to write your profile. Check the app data folder permissions.' : '无法写入个人资料文件，请检查应用数据目录的写入权限';
  return `${english ? 'Unable to save your profile' : '保存失败'}${detail ? `：${detail}` : ''}`;
}
