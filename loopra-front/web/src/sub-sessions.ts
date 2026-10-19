// Sub-agent session replay, ported from legacy `src/utils/subAgentBlocks.js` and
// the `subSessionsAPI` helpers: list a parent session's sub-agent runs, rebuild
// their blocks from the stored events, and continue an active run.
import type { ChatBlock, ToolStatus } from './chat';

export type SubSession = {
  subSessionId: string; task?: string; name?: string; title?: string; profile?: string;
  status: string; startedAt: number; endedAt: number; eventCount: number; mtime?: number;
};

export type SubSessionEvent = {
  type?: string; toolCallId?: string; subId?: string | number; subSessionId?: string; task?: string; name?: string; title?: string;
  content?: string; token?: string; args?: unknown; result?: unknown; error?: string; status?: string;
  startedAt?: number; endedAt?: number; finishedAt?: number; description?: string;
  options?: { title?: string; value?: string; summary?: string }[];
};

const subParams = (workspaceHash: string, sessionName: string) => new URLSearchParams({ workspaceHash, sessionName }).toString();
export const subSessionsPath = (workspaceHash: string, sessionName: string) => `/sub-sessions?${subParams(workspaceHash, sessionName)}`;
export const subSessionEventsPath = (subSessionId: string, workspaceHash: string, sessionName: string) => `/sub-sessions/${encodeURIComponent(subSessionId)}/events?${subParams(workspaceHash, sessionName)}`;
export const subSessionChatPath = (subSessionId: string, workspaceHash: string, sessionName: string) => `/sub-sessions/${encodeURIComponent(subSessionId)}/chat?${subParams(workspaceHash, sessionName)}`;

export function subStatusLabel(status?: string) {
  if (status === 'running') return '运行中';
  if (status === 'aborted') return '已取消';
  if (status === 'error') return '失败';
  if (status === 'completed') return '已完成';
  return status || '未知';
}

export function subStatusValue(status?: string): ToolStatus {
  if (status === 'running') return '执行中';
  if (status === 'error') return '失败';
  return '成功';
}

/** Legacy shows `name：title`, falling back to task for older records. */
export function subSessionLabel(item: SubSession) {
  const name = item.name?.trim();
  const title = item.title?.trim();
  if (name && title) return `${name}：${title}`;
  return name || title || item.task?.trim() || '子代理';
}

export function formatSubTime(timestamp?: number) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const text = (value: unknown) => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);

function argsObject(value: unknown): Record<string, unknown> {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : { value };
  } catch { return { value: String(value) }; }
}

/**
 * Rebuild the replay blocks for a stored sub-agent session. Event-level
 * semantics match legacy subAgentBlocks.js: content/reasoning segments append
 * to the previous block of the same kind, tool results fill the newest
 * unfinished call (matched by name when possible).
 */
export function subSessionBlocks(events: SubSessionEvent[]) {
  const blocks: ChatBlock[] = [];
  // No `sub_end` yet means the run is still going (a finished record always ends
  // with it); reporting "completed" here would stop live sub-agent tabs from polling.
  let status = 'running';
  let sequence = 0;
  const nextId = () => `sub-${sequence++}`;
  events.forEach(event => {
    const type = String(event.type || '');
    if (type === 'sub_start') return;
    // Local-only event appended when the user continues an active run.
    if (type === 'sub_user') {
      blocks.push({ id: nextId(), type: 'content', content: `**你：** ${text(event.content)}` });
      return;
    }
    if (type === 'sub_content') {
      const content = text(event.token ?? event.content);
      const last = blocks.at(-1);
      if (last?.type === 'content') last.content += content;
      else if (content.trim()) blocks.push({ id: nextId(), type: 'content', content });
      return;
    }
    if (type === 'sub_reasoning') {
      const content = text(event.content ?? event.token);
      const last = blocks.at(-1);
      if (last?.type === 'reasoning') last.content += content;
      else if (content.trim()) blocks.push({ id: nextId(), type: 'reasoning', content });
      return;
    }
    if (type === 'sub_tool_call') {
      blocks.push({ id: nextId(), type: 'tool_call', ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}), name: String(event.name || 'unknown'), status: '执行中', args: argsObject(event.args) });
      return;
    }
    if (type === 'sub_tool_result') {
      const result = text(event.result ?? event.content);
      const name = String(event.name || '');
      const candidates = blocks.filter((block): block is Extract<ChatBlock, { type: 'tool_call' }> => block.type === 'tool_call' && block.status === '执行中');
      const target = event.toolCallId ? blocks.find(block => block.type === 'tool_call' && block.toolCallId === event.toolCallId) as Extract<ChatBlock, { type: 'tool_call' }> | undefined : (name ? [...candidates].reverse().find(block => block.name === name) : undefined) || candidates.at(-1);
      if (target) { target.result = result; target.status = event.status ? (event.status === 'failed' ? '失败' : '成功') : /^(错误|Error|Exception)/i.test(result) ? '失败' : '成功'; }
      return;
    }
    if (type === 'sub_error') {
      blocks.push({ id: nextId(), type: 'content', content: `❌ ${text(event.error ?? event.content) || '未知错误'}` });
      return;
    }
    if (type === 'sub_choice') {
      blocks.push({
        id: nextId(), type: 'choice',
        question: event.title ? `子代理 ${event.title}` : '子代理工具调用需要审批',
        description: event.description,
        subId: event.subId == null ? undefined : String(event.subId),
        options: (event.options || []).map(option => ({ title: String(option.title || ''), value: option.value, description: option.summary })),
      });
      return;
    }
    if (type === 'sub_end') status = String(event.status || 'completed');
  });
  return { blocks, status };
}

/** Continue an active sub-agent session, streaming sub_* events as they arrive. */
export async function continueSubSession(
  base: string, subSessionId: string, message: string, workspaceHash: string, sessionName: string,
  emit: (event: SubSessionEvent) => void, signal?: AbortSignal,
) {
  const response = await fetch(`${base}${subSessionChatPath(subSessionId, workspaceHash, sessionName)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }), signal,
  });
  if (!response.ok) throw new Error(`继续对话失败（HTTP ${response.status}）`);
  if (!response.body) throw new Error('浏览器未收到子代理流');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let field = '';
  let data: string[] = [];
  const line = (raw: string) => {
    if (!raw) {
      if (data.length) {
        const value = data.join('\n');
        try {
          const parsed = JSON.parse(value) as SubSessionEvent;
          // The SSE event name carries the type when the payload omits it.
          emit(parsed.type ? parsed : { ...parsed, type: field });
        } catch { /* Ignore keep-alive or non-JSON frames. */ }
      }
      field = ''; data = []; return;
    }
    if (raw.startsWith(':')) return;
    const colon = raw.indexOf(':');
    const key = colon < 0 ? raw : raw.slice(0, colon);
    const rest = colon < 0 ? '' : raw.slice(colon + 1).replace(/^ /, '');
    if (key === 'event') field = rest;
    if (key === 'data') data.push(rest);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? '' : decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, index).replace(/\r$/, '')); buffer = buffer.slice(index + 1); }
      if (done) break;
    }
    if (buffer) line(buffer.replace(/\r$/, ''));
    line('');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
