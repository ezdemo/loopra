/**
 * Legacy `Chat.vue` floating log stack.
 *
 * The old view kept a `currentLogs` array fed by three sources: `log` SSE
 * events, the global `copy-success` event and the generic `app-notify` event.
 * Each entry auto-expires after six seconds and can be clicked to copy the
 * formatted line, which itself pushes a new "log copied" entry.
 */

export type ChatLogLevel = 'info' | 'warn' | 'error';
export type ChatLogEntry = { id: string; level: ChatLogLevel; text: string; time: number };

/** Legacy auto-dismiss timeout for a single floating log bar. */
export const CHAT_LOG_TIMEOUT_MS = 6000;
/** Legacy keeps the stack short so it never covers the composer. */
export const CHAT_LOG_LIMIT = 6;

/** Legacy uppercased the SSE level and dropped `DEBUG` entries entirely. */
export function chatLogLevel(raw?: string): ChatLogLevel | null {
  const level = (raw || 'INFO').toUpperCase();
  if (level === 'DEBUG') return null;
  if (level === 'WARN' || level === 'WARNING') return 'warn';
  if (level === 'ERROR' || level === 'FATAL') return 'error';
  return 'info';
}

/** Legacy accepted both `message` and `content` payloads for `log` events. */
export function chatLogText(payload: { message?: string; content?: string; text?: string } | string | null | undefined) {
  if (payload == null) return '';
  if (typeof payload === 'string') return payload;
  return payload.message || payload.content || payload.text || '';
}

export function appendChatLog(entries: ChatLogEntry[], entry: ChatLogEntry, limit = CHAT_LOG_LIMIT) {
  return [entry, ...entries.filter(item => item.id !== entry.id)].slice(0, limit);
}

export function removeChatLog(entries: ChatLogEntry[], id: string) {
  return entries.filter(item => item.id !== id);
}

/** Legacy `copyLog()` format: `[HH:mm:ss] text`. */
export function chatLogCopyText(entry: { text: string; time: number }) {
  return `[${new Date(entry.time).toLocaleTimeString('zh-CN', { hour12: false })}] ${entry.text}`;
}

export function chatLogTime(time: number) {
  return new Date(time).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
