export type BotChat = { chatId: string; sessionName: string; chatType: string; updatedAt: number };
export type Bot = {
  id: string; name: string; platform: string; appId: string; ownerId: string; workspaceHash: string;
  enabled: boolean; allowedUserIds: string[]; allowedChatIds: string[]; chats: BotChat[];
  state: string; error?: string; createdAt: number;
};
export type BotRegistration = {
  id: string; name: string; state: string; url?: string; qrCode?: string;
  expiresAt?: number; botId?: string; error?: string;
};

export function botStateLabel(state: string, english = false) {
  const labels: Record<string, [string, string]> = {
    connected: ['已连接', 'Connected'], connecting: ['连接中', 'Connecting'],
    reconnecting: ['重新连接中', 'Reconnecting'], disabled: ['已停用', 'Disabled'],
    offline: ['离线', 'Offline'], error: ['连接失败', 'Connection failed'],
  };
  return labels[state]?.[english ? 1 : 0] ?? (english ? 'Offline' : '离线');
}

export function botAccessIDs(text: string) {
  return [...new Set(text.split(/[\s,，]+/).map(value => value.trim()).filter(Boolean))];
}
