import { LoopraClient, applyEvent, historyMessages, withChatWorkspace, CHAT_WORKSPACE } from '@web/backend';
import type { AgentEngine, HistoryMessage, RemoteConfig, RemoteSession, StreamEvent, Workspace } from '@web/backend';
import type { Message, ChoiceBlockData } from '@web/chat';
import { resolveChoiceBlock } from '@web/chat';
import type { ElicitationRequest } from '@web/elicitation';

export type MobileThread = RemoteSession & { id: string; workspaceHash: string };
export type ThreadView = { messages: Message[]; loading: boolean; running: boolean; requestId?: string; error?: string; inputs?: ElicitationRequest[] };
export type MobileSnapshot = {
  workspaces: Workspace[]; threads: MobileThread[]; selected?: MobileThread;
  views: Record<string, ThreadView>; config?: RemoteConfig; engines: AgentEngine[];
  loading: boolean; error?: string;
};
export type ModelChoice = { id: string; name: string; channel: string; label: string };
export const threadId = (workspaceHash: string, name: string) => JSON.stringify([workspaceHash, name]);
export const threadQuery = (thread: MobileThread) => new URLSearchParams({ workspaceHash: thread.workspaceHash, sessionName: thread.name }).toString();
export const emptyView = (): ThreadView => ({ messages: [], loading: false, running: false });
export function modelChoices(config?: RemoteConfig): ModelChoice[] {
  return (config?.modelChannels || []).flatMap(channel => channel.models.map(model => ({
    id: JSON.stringify([channel.id, model.name]), name: model.name, channel: channel.id,
    label: model.displayName || model.name,
  })));
}
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Owns phone navigation and streams independently of the desktop workbench. */
export class MobileSessionStore {
  private state: MobileSnapshot = { workspaces: [], threads: [], views: {}, engines: [], loading: true };
  private listeners = new Set<() => void>();
  private lifetime = new AbortController();
  private selection?: AbortController;
  private catalog?: AbortController;
  private streams = new Map<string, { controller: AbortController; requestId: string; stopping: boolean }>();
  private syncing = false;
  private submitting = false;
  constructor(private api: Pick<LoopraClient, 'request' | 'stream'>) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.state;
  private publish(patch: Partial<MobileSnapshot>) {
    if (this.lifetime.signal.aborted) return;
    this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener());
  }
  private view(id: string, update: (value: ThreadView) => ThreadView) {
    this.publish({ views: { ...this.state.views, [id]: update(this.state.views[id] || emptyView()) } });
  }
  async refresh() {
    this.catalog?.abort();
    const controller = new AbortController(); this.catalog = controller;
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    this.publish({ loading: true, error: undefined });
    try {
      const [projects, config, engines] = await Promise.all([
        this.api.request<Workspace[]>('/workspaces', 'GET', undefined, signal),
        this.api.request<RemoteConfig>('/config', 'GET', undefined, signal),
        this.api.request<AgentEngine[]>('/agent-engines', 'GET', undefined, signal),
      ]);
      const workspaces = withChatWorkspace(projects);
      const threads: MobileThread[] = [];
      // Leave relay capacity for chat and cancellation on desktops with many projects.
      for (let index = 0; index < workspaces.length; index += 4) {
        const lists = await Promise.all(workspaces.slice(index, index + 4).map(async workspace => {
          const sessions = await this.api.request<RemoteSession[]>(`/sessions?workspaceHash=${encodeURIComponent(workspace.hash)}`, 'GET', undefined, signal);
          return sessions.map(session => ({ ...session, workspaceHash: workspace.hash, id: threadId(workspace.hash, session.name) }));
        }));
        threads.push(...lists.flat());
      }
      if (signal.aborted) return;
      // A new thread created while the catalog was loading must remain visible.
      const ids = new Set(threads.map(item => item.id));
      const active = this.state.threads.filter(item => this.streams.has(item.id) && !ids.has(item.id));
      this.publish({ workspaces, config, engines, threads: [...active, ...threads].sort((a, b) => b.mtime - a.mtime), loading: false });
    } catch (error) { if (!signal.aborted) this.publish({ loading: false, error: messageOf(error) }); }
  }
  async select(thread?: MobileThread) {
    this.selection?.abort(); this.selection = new AbortController();
    this.publish({ selected: thread });
    if (!thread || this.streams.has(thread.id)) return;
    await this.read(thread, true);
  }
  private async read(thread: MobileThread, initial: boolean) {
    if (!this.selection) return;
    const signal = AbortSignal.any([this.selection.signal, this.lifetime.signal]);
    if (initial) this.view(thread.id, value => ({ ...value, loading: true, error: undefined }));
    try {
      const status = await this.api.request<{ running: boolean; requestId?: string; title?: string }>(`/agent/session-status?${threadQuery(thread)}`, 'GET', undefined, signal);
      if (signal.aborted || this.streams.has(thread.id)) return;
      const old = this.state.views[thread.id];
      if (initial || status.running || old?.running || old?.error) {
        const history = await this.api.request<HistoryMessage[]>(`/agent/history?${threadQuery(thread)}`, 'GET', undefined, signal);
        const permissions = status.running ? await this.api.request<StreamEvent[]>(`/chat/permissions?${threadQuery(thread)}`, 'GET', undefined, signal) : [];
        const inputs = status.running ? await this.api.request<ElicitationRequest[]>(`/chat/elicitations?${threadQuery(thread)}`, 'GET', undefined, signal) : [];
        if (signal.aborted || this.streams.has(thread.id)) return;
        const messages = historyMessages(history);
        for (const permission of permissions) {
          if (messages.at(-1)?.role !== 'assistant') messages.push({ id: `permission-${permission.permissionRequestId}`, role: 'assistant', text: '', blocks: [] });
          messages[messages.length - 1] = applyEvent(messages[messages.length - 1], { ...permission, type: 'choice' });
        }
        this.view(thread.id, () => ({ messages, inputs, loading: false, running: status.running, requestId: status.requestId }));
      }
      if (status.title) this.publish({ threads: this.state.threads.map(item => item.id === thread.id ? { ...item, title: status.title } : item) });
    } catch (error) { if (!signal.aborted) this.view(thread.id, value => ({ ...value, loading: false, error: messageOf(error) })); }
    finally { if (!signal.aborted) this.view(thread.id, value => ({ ...value, loading: false })); }
  }
  async sync() {
    const thread = this.state.selected;
    if (this.syncing || !thread || this.streams.has(thread.id)) return;
    this.syncing = true;
    try { await this.read(thread, false); } finally { this.syncing = false; }
  }
  async send(text: string, options: { workspaceHash: string; agentId: string; model?: ModelChoice; effort?: string }, control = false, onAccepted?: () => void) {
    if (!text.trim() || this.submitting) return false;
    let thread = this.state.selected;
    if (thread && (this.streams.has(thread.id) || this.state.views[thread.id]?.running || this.state.views[thread.id]?.loading)) throw new Error('当前会话仍在回复，请等待或停止后发送');
    this.submitting = true;
    let preparing = true;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    try {
      if (!thread) {
        const created = await this.api.request<{ sessionName: string; agentId: string }>('/agent-engines/prepare', 'POST', { workspaceHash: options.workspaceHash || CHAT_WORKSPACE.hash, agentId: options.agentId }, signal);
        signal.throwIfAborted();
        thread = { id: threadId(options.workspaceHash, created.sessionName), workspaceHash: options.workspaceHash, name: created.sessionName, agentId: created.agentId, title: text.slice(0, 50), mtime: Date.now(), messageCount: 0 };
        this.selection?.abort(); this.selection = new AbortController();
        this.publish({ selected: thread, threads: [thread, ...this.state.threads.filter(item => item.id !== thread!.id)] });
      }
      const target = thread;
      this.selection?.abort(); this.selection = new AbortController();
      const requestId = crypto.randomUUID();
      const run = { controller, requestId, stopping: false }; this.streams.set(target.id, run);
      const answer: Message = { id: crypto.randomUUID(), role: 'assistant', text: '', blocks: [], startedAt: Date.now() };
      this.view(target.id, value => ({ ...value, error: undefined, loading: false, running: true, requestId, messages: [...value.messages, ...(control ? [] : [{ id: crypto.randomUUID(), role: 'user' as const, text }]), answer] }));
      // Release the composer after claiming the stream, rather than after a whole reply.
      this.submitting = false;
      preparing = false;
      onAccepted?.();
      try {
        await this.api.stream({ message: text, requestId, workspaceHash: target.workspaceHash, sessionName: target.name, agentId: target.agentId || options.agentId,
          ...(options.model ? { model: options.model.name, modelChannelId: options.model.channel } : {}), reasoningEffort: options.effort,
        }, event => {
          if (signal.aborted || this.streams.get(target.id) !== run) return;
          if (event.type === 'elicitation' && event.elicitationRequestId && event.schema) {
            const input: ElicitationRequest = { elicitationRequestId: event.elicitationRequestId, message: event.message || '请回答以下问题', schema: event.schema };
            this.view(target.id, value => ({ ...value, inputs: [...(value.inputs || []).filter(item => item.elicitationRequestId !== input.elicitationRequestId), input] })); return;
          }
          if (event.type === 'elicitation_resolved') { this.view(target.id, value => ({ ...value, inputs: value.inputs?.filter(input => input.elicitationRequestId !== event.elicitationRequestId) })); return; }
          this.view(target.id, value => ({ ...value, messages: value.messages.map(message => message.id === answer.id ? applyEvent(message, event) : message) }));
        }, signal);
      } catch (error) {
        if (!signal.aborted) this.view(target.id, value => ({ ...value, error: messageOf(error) }));
      } finally {
        if (this.streams.get(target.id) === run) {
          this.streams.delete(target.id);
          this.view(target.id, value => ({ ...value, running: false, messages: value.messages.map(message => message.id === answer.id ? { ...message, finishedAt: Date.now() } : message) }));
          // Read persisted history on the next sync, including a reply that outlived a lost stream.
          if (!this.lifetime.signal.aborted && this.state.selected?.id === target.id) await this.read(target, false);
        }
      }
      return true;
    } finally { if (preparing) this.submitting = false; }
  }
  async stop() {
    const thread = this.state.selected;
    if (!thread) return;
    const run = this.streams.get(thread.id);
    const requestId = run?.requestId || this.state.views[thread.id]?.requestId;
    if (!requestId) throw new Error('正在确认执行状态，请稍后重试');
    if (run?.stopping) return;
    if (run) run.stopping = true;
    try {
      await this.api.request('/chat/abort', 'POST', { requestId, workspaceHash: thread.workspaceHash, sessionName: thread.name }, this.lifetime.signal);
      run?.controller.abort();
      this.view(thread.id, value => ({ ...value, running: false }));
      if (!run) await this.read(thread, false);
    } catch (error) { if (run) run.stopping = false; throw error; }
  }
  async answer(choice: ChoiceBlockData, value: string, title: string, options: Parameters<MobileSessionStore['send']>[1]) {
    const thread = this.state.selected;
    if (!thread) return;
    if (choice.permissionRequestId) await this.api.request('/chat/permission', 'POST', { workspaceHash: thread.workspaceHash, sessionName: thread.name, permissionRequestId: choice.permissionRequestId, optionId: value }, this.lifetime.signal);
    else if (choice.subId) await this.api.request(`/chat/sub-hitl/${encodeURIComponent(choice.subId)}`, 'POST', { action: ['/agree', 'approve'].includes(value) ? 'approve' : 'deny' }, this.lifetime.signal);
    else { await this.send(value || title, options, true); }
    this.view(thread.id, current => ({ ...current, messages: current.messages.map(message => ({ ...message, blocks: message.blocks ? resolveChoiceBlock(message.blocks, choice.id, title) : undefined })) }));
  }
  async answerInput(elicitationRequestId: string, action: 'accept' | 'decline', content: Record<string, unknown>) {
    const thread = this.state.selected;
    if (!thread) return;
    await this.api.request('/chat/elicitation', 'POST', { workspaceHash: thread.workspaceHash, sessionName: thread.name, elicitationRequestId, action, content }, this.lifetime.signal);
    this.view(thread.id, value => ({ ...value, inputs: value.inputs?.filter(input => input.elicitationRequestId !== elicitationRequestId) }));
  }
  dispose() {
    this.lifetime.abort(); this.selection?.abort(); this.catalog?.abort();
    for (const stream of this.streams.values()) stream.controller.abort();
    this.streams.clear(); this.listeners.clear();
  }
}
