import type { ChatBlock, Message } from './chat';
import type { Provider, Session } from './lib';

export const DEFAULT_SERVER = 'http://127.0.0.1:4567';
export type Workspace = { hash: string; name: string; path: string };
export type RemoteSession = { name: string; title?: string; mtime: number; messageCount: number; current?: boolean; worktreeMode?: boolean };
export type Channel = { id: string; name: string; baseUrl: string; apiKey: string; apiProtocol: string; specialCompatibility: string; models: { name: string; contextTokens: number; maxTokens: number; imageInput: boolean; price?: Record<string, number> }[] };
export type RemoteConfig = { model: string; modelChannelId: string; modelChannels: Channel[]; reasoningEffort: string; hitl: string; fastMode: boolean; terminateOnNoToolCall: boolean; workspace: string; disabledTools: string[]; validationModel: string; validationModelChannelId: string; imageUnderstandingModel: string; imageUnderstandingModelChannelId: string };
export type StreamEvent = { type: string; content?: string; token?: string; error?: string; name?: string; args?: unknown; arguments?: unknown; result?: unknown; title?: string; question?: string; description?: string; options?: { title: string; value?: string; summary?: string }[]; changes?: { path: string; additions: number; deletions: number; created?: boolean; diff?: string }[]; subId?: string; task?: string; duration?: number; msgId?: string; hasCodeSnapshot?: boolean; plan?: string; mode?: string; tokensPerSecond?: number; avgTokensPerSecond?: number; done?: boolean; completionTokens?: number; level?: string; message?: string };
export type ChatRequest = { message: string; requestId: string; workspaceHash: string; sessionName: string; model: string; modelChannelId: string; reasoningEffort: string; fastMode: boolean; linkedProjectHashes?: string[]; images?: string[]; action?: string };

export function serverAddress(value: string) {
  const url = new URL(value.trim() || DEFAULT_SERVER);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请输入有效的 HTTP / HTTPS 服务地址');
  return url.href.replace(/\/+$/, '');
}

export class LoopraClient {
  readonly base: string;
  private readonly apiBase: string;
  constructor(base = DEFAULT_SERVER) {
    this.base = serverAddress(base);
    const localProxy = typeof window !== 'undefined' && ['3000', '5173'].includes(window.location.port) && this.base === DEFAULT_SERVER;
    const sameOrigin = typeof window !== 'undefined' && this.base === window.location.origin;
    this.apiBase = localProxy || sameOrigin ? '/api' : `${this.base}/api`;
  }
  assetUrl(path: string) { return `${this.apiBase}${path}`; }
  async request<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.apiBase}${path}`, { method, signal: signal || AbortSignal.timeout(30000), headers: body === undefined ? {} : { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json' }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const result = await response.json().catch(() => { throw new Error(`Loopra 返回了无效响应（HTTP ${response.status}）`); });
    if (!response.ok || result.success !== true) throw new Error(result.error || result.message || `HTTP ${response.status}`);
    return result.data as T;
  }
  async remoteModels(provider: Provider, signal?: AbortSignal): Promise<string[]> {
    if (!provider.baseUrl?.trim()) throw new Error('请先填写 API 地址');
    const baseUrl = serverAddress(provider.baseUrl);
    const apiKey = provider.apiKey?.trim() || '';
    if ((!apiKey || apiKey.includes('****')) && !provider.id) throw new Error('请先填写 API 密钥');
    // Resolve masked/blank keys on the backend; probe the form without saving it.
    const result = await this.request<unknown>('/remote-models', 'POST', {
      channelId: provider.id || undefined, baseUrl,
      ...(apiKey && !apiKey.includes('****') ? { apiKey } : {}),
      apiProtocol: provider.type, specialCompatibility: provider.compatibility || '',
    }, signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : undefined);
    if (!Array.isArray(result) || result.some(name => typeof name !== 'string')) throw new Error('Loopra 返回了无效的模型列表');
    return [...new Set((result as string[]).map(name => name.trim()).filter(Boolean))].sort();
  }
  async stream(body: ChatRequest, onEvent: (event: StreamEvent) => void, signal: AbortSignal) {
    const response = await fetch(`${this.apiBase}/chat/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Request-ID': body.requestId }, body: JSON.stringify(body), signal });
    if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || error.message || `无法建立聊天流（HTTP ${response.status}）`);
    }
    if (!response.body) throw new Error('浏览器未收到聊天流');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let completed = false;
    let terminalReply = false;
    const parser = new SseParser(event => {
      if (event.type === 'error') throw new Error(event.error || event.content || '模型请求失败');
      if (event.type === 'done') completed = true;
      else {
        // Loopra 26.9 sends complete (or a pending HITL choice), but its
        // emitter can close before writing done. Still read any trailing events.
        if (event.type === 'complete' || event.type === 'choice') terminalReply = true;
        if (event.type === 'stream_reset') terminalReply = false;
        onEvent(event);
      }
    });
    try {
      while (!completed) {
        const { value, done } = await reader.read();
        if (done) { parser.push(decoder.decode(), true); break; }
        parser.push(decoder.decode(value, { stream: true }));
      }
      if (!completed && !terminalReply) throw new Error('连接意外中断，回复可能不完整');
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}

// Keep partial lines and event frames across network chunks (including CRLF).
export class SseParser {
  private buffer = '';
  private type = '';
  private data: string[] = [];
  constructor(private emit: (event: StreamEvent) => void) {}
  push(chunk: string, end = false) {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) { this.line(this.buffer.slice(0, index).replace(/\r$/, '')); this.buffer = this.buffer.slice(index + 1); }
    if (end) { if (this.buffer) this.line(this.buffer.replace(/\r$/, '')); this.buffer = ''; this.line(''); }
  }
  private line(line: string) {
    if (!line) {
      if (this.data.length) {
        const raw = this.data.join('\n');
        let value: unknown;
        try { value = JSON.parse(raw); } catch { value = raw; }
        this.emit(raw === '[DONE]' ? { type: 'done' } : typeof value === 'object' && value !== null ? { ...value, type: this.type || 'content' } : { type: this.type || 'content', content: String(value) });
      }
      this.type = ''; this.data = []; return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const key = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (key === 'event') this.type = value;
    if (key === 'data') this.data.push(value);
  }
}

const stringify = (value: unknown) => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
const argsObject = (value: unknown): Record<string, unknown> => { try { const parsed = typeof value === 'string' ? JSON.parse(value) : value; return parsed && typeof parsed === 'object' ? parsed : { value }; } catch { return { value }; } };
export function applyEvent(message: Message, event: StreamEvent): Message {
  const blocks: ChatBlock[] = structuredClone(message.blocks || []);
  const id = `${message.id}-${blocks.length}`;
  const content = event.content ?? event.token ?? '';
  if (event.type === 'sub_choice') {
    blocks.push({ id, type: 'choice', subId: String(event.subId), question: event.title || '子代理工具调用需要审批', description: event.description, options: (event.options || []).map(option => ({ title: option.title, value: option.value, description: option.summary })) });
  } else if (event.type.startsWith('sub_')) {
    const subId = `${message.id}-sub-${event.subId || 'agent'}`;
    let sub = blocks.find(block => block.id === subId && block.type === 'sub_agent');
    if (!sub || sub.type !== 'sub_agent') { sub = { id: subId, type: 'sub_agent', name: event.task || '子代理', status: '执行中', blocks: [] }; blocks.push(sub); }
    if (event.task) sub.name = event.task;
    if (event.type === 'sub_end') sub.status = '成功';
    else if (event.type === 'sub_error') sub.status = '失败';
    else sub.blocks = applyEvent({ ...message, id: subId, blocks: sub.blocks }, { ...event, type: event.type.slice(4) }).blocks || [];
  } else if (event.type === 'reasoning_started') {
    // Encrypted reasoning opens a slot without any visible delta (legacy Chat.vue).
    if (blocks.at(-1)?.type !== 'reasoning_started') blocks.push({ id, type: 'reasoning_started', content: '' });
  } else if (event.type === 'content' || event.type === 'reasoning') {
    const last = blocks.at(-1);
    if (last?.type === event.type) last.content += content;
    else if (last?.type === 'reasoning_started' && event.type === 'reasoning') blocks[blocks.length - 1] = { id: last.id, type: 'reasoning', content };
    else if (content.trim()) blocks.push({ id, type: event.type, content });
  } else if (event.type === 'stream_reset') {
    // Retry invalidates only the current model segment, retaining completed tools.
    while (['content', 'reasoning', 'reasoning_started'].includes(blocks.at(-1)?.type || '')) blocks.pop();
  } else if (event.type === 'tool_call') blocks.push({ id, type: 'tool_call', name: event.name || 'unknown', status: '执行中', args: argsObject(event.args ?? event.arguments) });
  else if (event.type === 'tool_result') {
    const target = [...blocks].reverse().find(block => block.type === 'tool_call' && block.status === '执行中' && (!event.name || block.name === event.name));
    if (target?.type === 'tool_call') { target.result = stringify(event.result ?? content); target.status = /^(错误|Error|Exception)/i.test(target.result) ? '失败' : '成功'; if (event.duration) target.duration = `${event.duration}ms`; }
  } else if (event.type === 'file_changes' && event.changes?.length) {
    let summary = blocks.find(block => block.type === 'file_changes');
    if (!summary || summary.type !== 'file_changes') { summary = { id, type: 'file_changes', changes: [] }; blocks.push(summary); }
    for (const change of event.changes) { const old = summary.changes.find(item => item.path === change.path); if (old) { old.additions += change.additions || 0; old.deletions += change.deletions || 0; old.created ||= change.created; old.diff = [old.diff, change.diff].filter(Boolean).join('\n'); } else summary.changes.push(change); }
  } else if (event.type === 'choice' && event.options?.length) blocks.push({ id, type: 'choice', question: event.title || event.question || '请选择', description: event.description, options: event.options.map(option => ({ title: option.title, value: option.value, description: option.summary })) });
  else if (event.type === 'complete' && content && !blocks.some(block => block.type === 'content' && block.content.trim())) blocks.push({ id, type: 'content', content });
  return { ...message, blocks, text: blocks.flatMap(block => block.type === 'content' ? [block.content] : []).join('\n\n') };
}

export type HistoryMessage = { snapshot_id?: string; rollback_id?: string; role: string; content?: string | { type: string; text?: string; image_url?: { url: string } }[]; timestamp?: number; web_hidden?: boolean; webHidden?: boolean; reasoning_content?: string; response_reasoning?: unknown; responseReasoning?: unknown; tool_call_id?: string; tool_calls?: { id: string; function?: { name: string; arguments: unknown }; name?: string; arguments?: unknown }[]; file_changes?: StreamEvent['changes']; fileChanges?: StreamEvent['changes']; turn_started_at?: number; turn_finished_at?: number; tool_duration_ms?: number };

/** Legacy `chatHistory.hasEncryptedReasoning`: does a stored turn hide reasoning? */
export function hasEncryptedReasoning(value: unknown) {
  if (!value) return false;
  try {
    const item = (typeof value === 'string' ? JSON.parse(value) : value) as { type?: string; encrypted_content?: string } | null;
    return item?.type === 'reasoning' && typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0;
  } catch {
    return false;
  }
}

export function historyMessages(raw: HistoryMessage[]): Message[] {
  const messages: Message[] = [];
  const results = new Map(raw.filter(item => item.role === 'tool' && item.tool_call_id).map(item => [item.tool_call_id!, item]));
  let current: Message | undefined;
  for (const [index, entry] of raw.entries()) {
    const content = Array.isArray(entry.content) ? entry.content.filter(part => part.type === 'text').map(part => part.text || '').join('\n') : entry.content || '';
    const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
    if (entry.role === 'user') {
      current = undefined;
      if (!entry.web_hidden && !entry.webHidden) messages.push({ id: `history-${index}`, role: 'user', text: content, time, historyCount: index + 1, snapshotId: entry.snapshot_id, rollbackId: entry.rollback_id || entry.snapshot_id, rollbackTimestamp: entry.timestamp, images: Array.isArray(entry.content) ? entry.content.flatMap(part => part.image_url?.url ? [part.image_url.url] : []) : [] });
    } else if (entry.role === 'tool') {
      if (current) current.historyCount = index + 1;
    } else if (entry.role === 'assistant') {
      if (!current) { current = { id: `history-${index}`, role: 'assistant', text: '', blocks: [], time, startedAt: entry.turn_started_at || entry.timestamp, finishedAt: entry.turn_finished_at || entry.timestamp }; messages.push(current); }
      const events: StreamEvent[] = [];
      if (entry.reasoning_content) events.push({ type: 'reasoning', content: entry.reasoning_content });
      if (hasEncryptedReasoning(entry.response_reasoning || entry.responseReasoning)) events.push({ type: 'reasoning_started' });
      for (const call of entry.tool_calls || []) {
        const name = call.function?.name || call.name || 'unknown';
        events.push({ type: 'tool_call', name, args: call.function?.arguments ?? call.arguments });
        const result = results.get(call.id);
        if (result) events.push({ type: 'tool_result', name, result: result.content, duration: result.tool_duration_ms });
      }
      if (content.trim()) events.push({ type: 'content', content });
      if (entry.file_changes || entry.fileChanges) events.push({ type: 'file_changes', changes: entry.file_changes || entry.fileChanges });
      for (const event of events) Object.assign(current, applyEvent(current, event));
      current.finishedAt = entry.turn_finished_at || entry.timestamp || current.finishedAt;
      current.historyCount = index + 1;
    }
  }
  return messages;
}
export function remoteSession(item: RemoteSession, workspace: Workspace): Session {
  return { id: `${workspace.hash}/${item.name}`, name: item.name, workspaceHash: workspace.hash, title: item.title || item.name, workspace: workspace.name, kind: 'remote', messages: [], mtime: item.mtime, messageCount: item.messageCount || 0, worktreeMode: !!item.worktreeMode };
}
export function configProviders(config: RemoteConfig): Provider[] {
  return (config.modelChannels || []).map(channel => ({ id: channel.id, name: channel.name, type: channel.apiProtocol, baseUrl: channel.baseUrl, apiKey: channel.apiKey, compatibility: channel.specialCompatibility, count: channel.models.length, enabled: true, models: channel.models.map(model => ({ ...model, priceEnabled: !!model.price, inputPrice: model.price?.input || 0, cachePrice: model.price?.cache || 0, outputPrice: model.price?.output || 0 })) }));
}
export function providerChannels(providers: Provider[]) {
  return providers.map(provider => ({ id: provider.id, name: provider.name, baseUrl: provider.baseUrl || '', apiKey: provider.apiKey || '', apiProtocol: provider.type, specialCompatibility: provider.compatibility || '', models: (provider.models || []).map(model => ({ name: model.name, contextTokens: model.contextTokens, maxTokens: model.maxTokens, imageInput: model.imageInput, ...(model.priceEnabled ? { price: { input: model.inputPrice, cache: model.cachePrice, output: model.outputPrice } } : {}) })) }));
}
export function sessionQuery(session: Session) { return `workspaceHash=${encodeURIComponent(session.workspaceHash || '')}&sessionName=${encodeURIComponent(session.name || '')}`; }
export function sessionRoute(session: Session, suffix = '') { return `/sessions/${encodeURIComponent(session.name || '')}${suffix}?workspaceHash=${encodeURIComponent(session.workspaceHash || '')}`; }
export const permissionLabel = (hitl: string) => hitl === 'approval' ? '按需审批' : hitl === 'auto' ? '自动审批' : '完全自动';
export const permissionValue = (label: string) => label === '按需审批' ? 'approval' : label === '自动审批' ? 'auto' : 'free';

