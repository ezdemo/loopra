import type { Preferences } from './components/Settings';
import type { LocalProfile } from './local-profile';
import { normalizeUiScale } from './lib';

const profileColors = ['blue', 'violet', 'rose', 'amber', 'green', 'slate'] as const;

/** Settings that are not already stored by a dedicated Loopra API. */
export type StoredUIPreferences = {
  theme: 'light' | 'dark' | 'system';
  language: 'zh' | 'en';
  fontScale: number;
  notifications: boolean;
  sound: boolean;
  openWith: string;
  autoContext: boolean;
  animations: boolean;
  petEnabled?: boolean;
  hiddenSessions?: string[];
  profile?: { nickname: string; avatar: string; color: string };
  persisted?: boolean;
};

export type ClientSettings = {
  preferences: Preferences;
  profile: LocalProfile;
  petEnabled: boolean;
  hiddenSessions: string[];
};

export function toStoredPreferences(prefs: Preferences): Omit<StoredUIPreferences, 'persisted'> {
  return {
    theme: prefs.theme === '深色' ? 'dark' : prefs.theme === '跟随系统' ? 'system' : 'light',
    language: prefs.language === 'English' ? 'en' : 'zh',
    fontScale: normalizeUiScale(prefs.fontScale),
    notifications: prefs.notifications,
    sound: prefs.sound,
    openWith: prefs.openWith,
    autoContext: prefs.autoContext,
    animations: prefs.animations,
  };
}

export function fromStoredPreferences(saved: Partial<StoredUIPreferences>, fallback: Preferences): Preferences {
  return {
    ...fallback,
    theme: saved.theme === 'dark' ? '深色' : saved.theme === 'system' ? '跟随系统' : saved.theme === 'light' ? '浅色' : fallback.theme,
    language: saved.language === 'en' ? 'English' : saved.language === 'zh' ? '简体中文' : fallback.language,
    fontScale: normalizeUiScale(typeof saved.fontScale === 'number' ? saved.fontScale : fallback.fontScale),
    notifications: typeof saved.notifications === 'boolean' ? saved.notifications : fallback.notifications,
    sound: typeof saved.sound === 'boolean' ? saved.sound : fallback.sound,
    openWith: typeof saved.openWith === 'string' && saved.openWith.trim() ? saved.openWith : fallback.openWith,
    autoContext: typeof saved.autoContext === 'boolean' ? saved.autoContext : fallback.autoContext,
    animations: typeof saved.animations === 'boolean' ? saved.animations : fallback.animations,
  };
}

export function toStoredSettings(settings: ClientSettings): Omit<StoredUIPreferences, 'persisted'> {
  return {
    ...toStoredPreferences(settings.preferences),
    petEnabled: settings.petEnabled,
    hiddenSessions: [...settings.hiddenSessions],
    profile: { nickname: settings.profile.nickname, avatar: settings.profile.avatar, color: settings.profile.color },
  };
}

/** Fields missing from an older file stay local, and complete is false so they get uploaded. */
export function mergeStoredSettings(saved: Partial<StoredUIPreferences>, local: ClientSettings): { settings: ClientSettings; complete: boolean } {
  const profilePresent = !!saved.profile && typeof saved.profile === 'object';
  const petPresent = typeof saved.petEnabled === 'boolean';
  const hiddenPresent = Array.isArray(saved.hiddenSessions);
  return {
    complete: profilePresent && petPresent && hiddenPresent,
    settings: {
      preferences: fromStoredPreferences(saved, local.preferences),
      profile: profilePresent ? {
        nickname: typeof saved.profile?.nickname === 'string' ? Array.from(saved.profile.nickname.trim()).slice(0, 32).join('') : '',
        avatar: typeof saved.profile?.avatar === 'string' && saved.profile.avatar.length <= 400_000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(saved.profile.avatar) ? saved.profile.avatar : '',
        color: profileColors.includes(saved.profile?.color as LocalProfile['color']) ? saved.profile!.color as LocalProfile['color'] : 'blue',
      } : local.profile,
      petEnabled: petPresent ? saved.petEnabled as boolean : local.petEnabled,
      hiddenSessions: hiddenPresent ? saved.hiddenSessions!.filter(id => typeof id === 'string' && id.trim()) : local.hiddenSessions,
    },
  };
}
