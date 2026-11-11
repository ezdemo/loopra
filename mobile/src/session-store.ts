import { LoopraClient, applyEvent, historyMessages, withChatWorkspace } from '@web/backend';
import type { AgentEngine, HistoryMessage, RemoteConfig, RemoteSession, StreamEvent, Workspace } from '@web/backend';
import type { AgentConfigOption } from '@web/agent-config';
import type { Message, ChoiceBlockData } from '@web/chat';
import { resolveChoiceBlock } from '@web/chat';
import type { ElicitationRequest } from '@web/elicitation';

export type MobileThread = RemoteSession & { id: string; workspaceHash: string };
export type QueuedMessage = { id: string; text: string; workspaceHash: string; agentId: string };
export type ThreadView = { messages: Message[]; queued: QueuedMessage[]; loading: boolean; running: boolean; requestId?: string; error?: string; inputs?: ElicitationRequest[] };
export type PreparedAgent = { key: string; workspaceHash: string; agentId: string; sessionName: string; options: AgentConfigOption[] };
export type MobileSnapshot = {
  workspaces: Workspace[]; threads: MobileThread[]; selected?: MobileThread;
  views: Record<string, ThreadView>; config?: RemoteConfig; engines: AgentEngine[];
  configs: Record<string, AgentConfigOption[]>; configLoading: Record<string, boolean>; configErrors: Record<string, string>;
  draft?: PreparedAgent; draftLoading: boolean; draftError?: string; configBusy: boolean;
  loading: boolean; error?: string;
};
export type ModelChoice = { id: string; name: string; channel: string; label: string };
export const agentConfigKey = (workspaceHash: string, agentId: string) => JSON.stringify([workspaceHash, agentId]);
export const threadId = (workspaceHash: string, name: string) => JSON.stringify([workspaceHash, name]);
export const threadQuery = (thread: MobileThread) => new URLSearchParams({ workspaceHash: thread.workspaceHash, sessionName: thread.name }).toString();
export const emptyView = (): ThreadView => ({ messages: [], queued: [], loading: false, running: false });
export function modelChoices(config?: RemoteConfig): ModelChoice[] {
  return (config?.modelChannels || []).flatMap(channel => channel.models.map(model => ({
    id: JSON.stringify([channel.id, model.name]), name: model.name, channel: channel.id,
    label: model.displayName || model.name,
  })));
}
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Owns phone navigation and streams independently of the desktop workbench. */
export class MobileSessionStore {
  private state: MobileSnapshot = { workspaces: [], threads: [], views: {}, engines: [], configs: {}, configLoading: {}, configErrors: {}, draftLoading: false, configBusy: false, loading: true };
  private listeners = new Set<() => void>();
  private lifetime = new AbortController();
  private selection?: AbortController;
  private catalog?: AbortController;
  private streams = new Map<string, { controller: AbortController; requestId: string; stopping: boolean }>();
  private configRequests = new Map<string, AbortController>();
  private draftRequest?: { key: string; controller: AbortController; promise: Promise<PreparedAgent | undefined> };
  private draining = new Set<string>();
  private queueRetries = new Map<string, ReturnType<typeof setTimeout>>();
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
    if (!thread) return;
    void this.loadConfig(thread);
    if (this.streams.has(thread.id)) return;
    await this.read(thread, true);
    if (!this.state.views[thread.id]?.error) this.drainQueue(thread);
  }
  async loadConfig(thread: MobileThread) {
    this.configRequests.get(thread.id)?.abort();
    const controller = new AbortController();
    this.configRequests.set(thread.id, controller);
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    this.publish({ configLoading: { ...this.state.configLoading, [thread.id]: true }, configErrors: { ...this.state.configErrors, [thread.id]: '' } });
    try {
      const result = await this.api.request<{ configOptions: AgentConfigOption[] }>(`/agent-engines/config?${threadQuery(thread)}`, 'GET', undefined, signal);
      if (signal.aborted) return undefined;
      this.publish({ configs: { ...this.state.configs, [thread.id]: result.configOptions || [] } });
      return result.configOptions || [];
    } catch (error) {
      if (!signal.aborted) this.publish({ configErrors: { ...this.state.configErrors, [thread.id]: messageOf(error) } });
      return undefined;
    } finally {
      if (this.configRequests.get(thread.id) === controller) {
        this.configRequests.delete(thread.id);
        this.publish({ configLoading: { ...this.state.configLoading, [thread.id]: false } });
      }
    }
  }
  prepareDraft(workspaceHash: string, agentId: string) {
    const key = agentConfigKey(workspaceHash, agentId);
    if (this.draftRequest?.key === key) return this.draftRequest.promise;
    if (this.state.draft?.key === key) return Promise.resolve(this.state.draft);
    this.draftRequest?.controller.abort();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    this.publish({ draftLoading: true, draftError: undefined });
    const promise = (async () => {
      try {
        const prepared = await this.api.request<{ sessionName: string; agentId: string; configOptions: AgentConfigOption[] }>('/agent-engines/prepare', 'POST', { workspaceHash, agentId }, signal);
        if (signal.aborted) return undefined;
        const draft: PreparedAgent = { key, workspaceHash, agentId: prepared.agentId || agentId, sessionName: prepared.sessionName, options: prepared.configOptions || [] };
        this.publish({ draft, draftLoading: false, draftError: undefined });
        return draft;
      } catch (error) {
        if (!signal.aborted) this.publish({ draftLoading: false, draftError: messageOf(error) });
        return undefined;
      } finally {
        if (this.draftRequest?.controller === controller) this.draftRequest = undefined;
      }
    })();
    this.draftRequest = { key, controller, promise };
    return promise;
  }
  async changeConfig(target: { workspaceHash: string; sessionName: string; agentId: string; threadId?: string }, configId: string, value: string | boolean): Promise<AgentConfigOption[]> {
    this.publish({ configBusy: true });
    try {
      const result = await this.api.request<{ configOptions: AgentConfigOption[] }>('/agent-engines/config', 'PUT', {
        workspaceHash: target.workspaceHash, sessionName: target.sessionName, configId, value,
      }, this.lifetime.signal);
      const options = result.configOptions || [];
      if (target.threadId) this.publish({ configs: { ...this.state.configs, [target.threadId]: options }, configErrors: { ...this.state.configErrors, [target.threadId]: '' } });
      else if (this.state.draft && this.state.draft.workspaceHash === target.workspaceHash && this.state.draft.sessionName === target.sessionName) {
        this.publish({ draft: { ...this.state.draft, options }, draftError: undefined });
      }
      return options;
    } finally { this.publish({ configBusy: false }); }
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
        this.view(thread.id, value => ({ ...value, messages, inputs, loading: false, running: status.running, requestId: status.requestId, error: undefined }));
      }
      if (status.title) this.publish({ threads: this.state.threads.map(item => item.id === thread.id ? { ...item, title: status.title } : item) });
    } catch (error) { if (!signal.aborted) this.view(thread.id, value => ({ ...value, loading: false, error: messageOf(error) })); }
    finally { if (!signal.aborted) this.view(thread.id, value => ({ ...value, loading: false })); }
  }
  async sync() {
    const thread = this.state.selected;
    if (this.syncing || !thread || this.streams.has(thread.id)) return;
    this.syncing = true;
    try {
      await this.read(thread, false);
      if (!this.state.views[thread.id]?.error) this.drainQueue(thread);
    } finally { this.syncing = false; }
  }
  async send(text: string, options: { workspaceHash: string; agentId: string }, control = false, onAccepted?: () => void, targetThread?: MobileThread) {
    if (!text.trim()) return false;
    const thread = targetThread || this.state.selected;
    if (thread && !control && (this.streams.has(thread.id) || this.state.views[thread.id]?.running)) {
      this.view(thread.id, value => ({ ...value, queued: [...(value.queued || []), { id: crypto.randomUUID(), text: text.trim(), workspaceHash: options.workspaceHash, agentId: options.agentId }] }));
      onAccepted?.();
      return true;
    }
    return this.sendNow(text, options, control, onAccepted, thread);
  }
  private async sendNow(text: string, options: { workspaceHash: string; agentId: string }, control = false, onAccepted?: () => void, targetThread?: MobileThread) {
    let thread = targetThread || this.state.selected;
    if (this.submitting) return false;
    if (thread && (this.streams.has(thread.id) || this.state.views[thread.id]?.running || this.state.views[thread.id]?.loading)) throw new Error('当前会话仍在回复，请等待或停止后发送');
    this.submitting = true;
    let preparing = true;
    let failed = false;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    try {
      if (!thread) {
        const key = agentConfigKey(options.workspaceHash, options.agentId);
        const prepared = this.state.draft?.key === key ? this.state.draft : await this.prepareDraft(options.workspaceHash, options.agentId);
        signal.throwIfAborted();
        if (!prepared) throw new Error(this.state.draftError || '准备会话失败');
        thread = { id: threadId(prepared.workspaceHash, prepared.sessionName), workspaceHash: prepared.workspaceHash, name: prepared.sessionName, agentId: prepared.agentId, title: text.slice(0, 50), mtime: Date.now(), messageCount: 0 };
        this.selection?.abort(); this.selection = new AbortController();
        this.publish({ selected: thread, threads: [thread, ...this.state.threads.filter(item => item.id !== thread!.id)], configs: { ...this.state.configs, [thread.id]: prepared.options }, draft: undefined });
      }
      const target = thread;
      if (this.state.selected?.id === target.id) { this.selection?.abort(); this.selection = new AbortController(); }
      const requestId = crypto.randomUUID();
      const run = { controller, requestId, stopping: false }; this.streams.set(target.id, run);
      const answer: Message = { id: crypto.randomUUID(), role: 'assistant', text: '', blocks: [], startedAt: Date.now() };
      this.view(target.id, value => ({ ...value, error: undefined, loading: false, running: true, requestId, messages: [...value.messages, ...(control ? [] : [{ id: crypto.randomUUID(), role: 'user' as const, text }]), answer] }));
      // Release the composer after claiming the stream, rather than after a whole reply.
      this.submitting = false;
      preparing = false;
      onAccepted?.();
      try {
        await this.api.stream({ message: text, requestId, workspaceHash: target.workspaceHash, sessionName: target.name, agentId: target.agentId || options.agentId }, event => {
          if (signal.aborted || this.streams.get(target.id) !== run) return;
          if (event.type === 'config_options' && event.configOptions) {
            this.configRequests.get(target.id)?.abort();
            this.publish({ configs: { ...this.state.configs, [target.id]: event.configOptions } }); return;
          }
          if (event.type === 'elicitation' && event.elicitationRequestId && event.schema) {
            const input: ElicitationRequest = { elicitationRequestId: event.elicitationRequestId, message: event.message || '请回答以下问题', schema: event.schema };
            this.view(target.id, value => ({ ...value, inputs: [...(value.inputs || []).filter(item => item.elicitationRequestId !== input.elicitationRequestId), input] })); return;
          }
          if (event.type === 'elicitation_resolved') { this.view(target.id, value => ({ ...value, inputs: value.inputs?.filter(input => input.elicitationRequestId !== event.elicitationRequestId) })); return; }
          this.view(target.id, value => ({ ...value, messages: value.messages.map(message => message.id === answer.id ? applyEvent(message, event) : message) }));
        }, signal);
      } catch (error) {
        failed = true;
        if (!signal.aborted) this.view(target.id, value => ({ ...value, error: messageOf(error) }));
      } finally {
        const stopping = run.stopping;
        if (this.streams.get(target.id) === run) {
          this.streams.delete(target.id);
          this.view(target.id, value => ({ ...value, running: false, messages: value.messages.map(message => message.id === answer.id ? { ...message, finishedAt: Date.now() } : message) }));
          if (!stopping && !this.lifetime.signal.aborted) {
            // Read persisted history on the next sync, including a reply that outlived a lost stream.
            if (this.state.selected?.id === target.id) await this.read(target, false);
            if (!failed && !this.state.views[target.id]?.error) this.drainQueue(target);
          }
        }
      }
      return true;
    } finally { if (preparing) this.submitting = false; }
  }
  private drainQueue(thread: MobileThread) {
    if (this.draining.has(thread.id) || this.streams.has(thread.id) || this.state.views[thread.id]?.running) return;
    if (!this.state.views[thread.id]?.queued?.[0]) return;
    this.draining.add(thread.id);
    void (async () => {
      try {
        while (!this.lifetime.signal.aborted) {
          if (this.streams.has(thread.id) || this.state.views[thread.id]?.running) return;
          const next = this.state.views[thread.id]?.queued?.[0];
          if (!next) return;
          let accepted = false;
          try {
            await this.sendNow(next.text, { workspaceHash: next.workspaceHash, agentId: next.agentId }, false, () => {
              accepted = true;
              this.removeQueued(thread.id, next.id);
            }, thread);
          } catch (error) {
            this.view(thread.id, value => ({ ...value, error: messageOf(error) }));
            return;
          }
          // A failed stream or history refresh leaves the remaining queue for a later retry.
          if (!accepted) { this.scheduleQueueDrain(thread); return; }
          if (this.state.views[thread.id]?.error) return;
        }
      } finally {
        this.draining.delete(thread.id);
      }
    })();
  }
  private scheduleQueueDrain(thread: MobileThread) {
    if (this.lifetime.signal.aborted || this.queueRetries.has(thread.id)) return;
    const timer = setTimeout(() => {
      this.queueRetries.delete(thread.id);
      this.drainQueue(thread);
    }, 350);
    this.queueRetries.set(thread.id, timer);
  }
  removeQueued(threadId: string, id: string) {
    this.view(threadId, value => ({ ...value, queued: (value.queued || []).filter(item => item.id !== id) }));
  }
  promoteQueued(threadId: string, id: string) {
    const current = this.state.views[threadId]?.queued || [];
    const item = current.find(entry => entry.id === id);
    if (!item || current[0]?.id === id) return;
    this.view(threadId, value => ({ ...value, queued: [item, ...(value.queued || []).filter(entry => entry.id !== id)] }));
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
      if (run) await this.waitForStreamEnd(thread.id);
      await this.waitUntilIdle(thread);
      if (this.state.selected?.id === thread.id) await this.read(thread, false);
      this.view(thread.id, value => ({ ...value, running: false, requestId: undefined }));
      if (!this.state.views[thread.id]?.error) this.drainQueue(thread);
    } catch (error) {
      if (run && !run.controller.signal.aborted) run.stopping = false;
      throw error;
    }
  }
  private async waitForStreamEnd(threadId: string) {
    const deadline = Date.now() + 5000;
    while (this.streams.has(threadId)) {
      if (Date.now() >= deadline) throw new Error('上一条回复仍在停止，消息已保留在队列中');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  private async waitUntilIdle(thread: MobileThread) {
    const deadline = Date.now() + 10000;
    while (true) {
      const status = await this.api.request<{ running: boolean; requestId?: string }>(`/agent/session-status?${threadQuery(thread)}`, 'GET', undefined, this.lifetime.signal);
      if (!status.running) {
        this.view(thread.id, value => ({ ...value, running: false, requestId: status.requestId }));
        return;
      }
      if (Date.now() >= deadline) throw new Error('上一条回复仍在停止，消息已保留在队列中');
      await new Promise(resolve => setTimeout(resolve, 250));
    }
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
    this.draftRequest?.controller.abort();
    for (const request of this.configRequests.values()) request.abort();
    this.configRequests.clear();
    for (const timer of this.queueRetries.values()) clearTimeout(timer);
    this.queueRetries.clear();
    for (const stream of this.streams.values()) stream.controller.abort();
    this.streams.clear(); this.listeners.clear();
  }
}
