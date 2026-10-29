import { useCallback, useEffect, useRef, useState } from 'react';
import { appendChatLog, chatLogCopyText, chatLogLevel, chatLogText, chatLogTime, CHAT_LOG_TIMEOUT_MS, removeChatLog, type ChatLogEntry, type ChatLogLevel } from '../chat-logs';

export type ChatLogInput = { level?: string; message?: string; content?: string; text?: string };

export type ChatLogsApi = {
  logs: ChatLogEntry[];
  push: (input: ChatLogInput | string, fallbackLevel?: ChatLogLevel) => void;
  dismiss: (id: string) => void;
};

/**
 * Legacy `Chat.vue` log stack: SSE `log` events plus the global `copy-success`
 * and `app-notify` window events. Every entry expires after six seconds.
 */
export function useChatLogs(): ChatLogsApi {
  const [logs, setLogs] = useState<ChatLogEntry[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const counter = useRef(0);
  const push = useCallback((input: ChatLogInput | string, fallbackLevel: ChatLogLevel = 'info') => {
    // Strings (window events) carry no level; SSE payloads do and DEBUG is dropped.
    const level = typeof input === 'string' ? fallbackLevel : chatLogLevel(input.level);
    const text = chatLogText(input);
    if (!level || !text) return;
    counter.current += 1;
    const entry: ChatLogEntry = { id: `${Date.now()}-${counter.current}`, level, text, time: Date.now() };
    setLogs(current => appendChatLog(current, entry));
    timers.current.set(entry.id, setTimeout(() => {
      timers.current.delete(entry.id);
      setLogs(current => removeChatLog(current, entry.id));
    }, CHAT_LOG_TIMEOUT_MS));
  }, []);
  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) { clearTimeout(timer); timers.current.delete(id); }
    setLogs(current => removeChatLog(current, id));
  }, []);
  useEffect(() => {
    const onCopy = (event: Event) => push({ text: `✅ ${(event as CustomEvent<string>).detail || '已复制'}` });
    const onNotify = (event: Event) => push({ text: (event as CustomEvent<string>).detail || '' });
    window.addEventListener('copy-success', onCopy);
    window.addEventListener('app-notify', onNotify);
    const active = timers.current;
    return () => {
      window.removeEventListener('copy-success', onCopy);
      window.removeEventListener('app-notify', onNotify);
      for (const timer of active.values()) clearTimeout(timer);
      active.clear();
    };
  }, [push]);
  return { logs, push, dismiss };
}

/** Renders the floating stack; clicking a bar copies its `[time] text` line. */
export default function ChatLogs({ logs, onDismiss, onCopy }: { logs: ChatLogEntry[]; onDismiss: (id: string) => void; onCopy: (text: string) => void }) {
  if (!logs.length) return null;
  return <div className="log-stack" aria-live="polite">
    {logs.map(entry => <div key={entry.id} className={`log-bar log-${entry.level}`} title="点击复制完整日志" onClick={() => onCopy(chatLogCopyText(entry))}>
      <span className="log-bar-icon" aria-hidden="true">📋</span>
      <span className="log-bar-text">{entry.text}</span>
      <span className="log-bar-time">{chatLogTime(entry.time)}</span>
      <button type="button" className="log-bar-close" title="关闭通知" aria-label="关闭通知" onClick={event => { event.stopPropagation(); onDismiss(entry.id); }}>✕</button>
    </div>)}
  </div>;
}
