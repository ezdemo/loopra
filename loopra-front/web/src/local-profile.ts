import { useEffect, useState } from 'react';
import { electronApi } from './desktop-shell';
import { loadDesktopProfile, persistLocalProfile, PROFILE_KEY } from './local-profile-storage';

export { PROFILE_KEY } from './local-profile-storage';
export const PROFILE_COLORS = ['blue', 'violet', 'rose', 'amber', 'green', 'slate'] as const;
export type LocalProfile = { nickname: string; avatar: string; color: typeof PROFILE_COLORS[number] };

export function normalizeProfile(value: unknown): LocalProfile {
  const profile = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    nickname: typeof profile.nickname === 'string' ? Array.from(profile.nickname.trim()).slice(0, 32).join('') : '',
    avatar: typeof profile.avatar === 'string' && profile.avatar.length <= 400_000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(profile.avatar) ? profile.avatar : '',
    color: PROFILE_COLORS.includes(profile.color as LocalProfile['color']) ? profile.color as LocalProfile['color'] : 'blue',
  };
}

function readProfile(): LocalProfile {
  try { return normalizeProfile(JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null')); }
  catch { return normalizeProfile(null); }
}

export function useLocalProfile() {
  const [profile, setProfile] = useState(readProfile);
  const [ready, setReady] = useState(!electronApi()?.localProfile?.get);
  useEffect(() => {
    let active = true;
    const desktop = electronApi()?.localProfile;
    if (desktop) {
      void loadDesktopProfile(desktop, readProfile()).then(value => { if (active) setProfile(normalizeProfile(value)); })
        .catch(() => {}).finally(() => { if (active) setReady(true); });
    }
    const onStorage = (event: StorageEvent) => { if (!desktop && event.key === PROFILE_KEY) setProfile(readProfile()); };
    window.addEventListener('storage', onStorage);
    return () => { active = false; window.removeEventListener('storage', onStorage); };
  }, []);
  async function saveProfile(value: LocalProfile) {
    const next = normalizeProfile(value);
    const desktop = electronApi()?.localProfile;
    await persistLocalProfile(next, localStorage, desktop || undefined);
    setProfile(next);
  }
  return { profile, ready, saveProfile };
}

/** Keep a small square raster, without the original photo's metadata. */
export async function createProfileAvatar(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('format');
  if (file.size > 10 * 1024 * 1024) throw new Error('size');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context || !image.naturalWidth || !image.naturalHeight) throw new Error('image');
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
    return canvas.toDataURL('image/png');
  } finally { URL.revokeObjectURL(url); }
}
