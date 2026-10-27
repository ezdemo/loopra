import type { ComposerContext, QueuedMessage } from './composer';

// Legacy Chat.vue kept queued messages per session (`queuedMessagesBySession`):
// sending while a reply streams appends to the queue, "引导" promotes one entry
// to the front and stops the running reply, and the stream end drains the queue.
export type MessageQueue = Record<string, QueuedMessage[]>;

export function queueFor(queue: MessageQueue, key: string): QueuedMessage[] {
  return queue[key] || [];
}

export function nextQueued(queue: MessageQueue, key: string): QueuedMessage | undefined {
  return queueFor(queue, key)[0];
}

export function enqueue(queue: MessageQueue, key: string, message: QueuedMessage): MessageQueue {
  return { ...queue, [key]: [...queueFor(queue, key), message] };
}

export function removeQueued(queue: MessageQueue, key: string, id: string): MessageQueue {
  const list = queueFor(queue, key);
  const next = list.filter(item => item.id !== id);
  return next.length === list.length ? queue : { ...queue, [key]: next };
}

/** Restore the queued content without discarding an existing unsent draft. */
export function restoreQueuedDraft(message: QueuedMessage, draft: string, context: ComposerContext): { draft: string; context: ComposerContext } {
  const attachments = [...(message.context.attachments || [])];
  const currentAttachments = context.attachments || [];
  const uploadedNames = new Set(currentAttachments.map(file => file.name));
  const files = new Set([...message.context.files, ...attachments.map(file => file.name), ...context.files.filter(name => !uploadedNames.has(name))]);
  const reserved = new Set([...files, ...context.files, ...currentAttachments.map(file => file.name)]);
  for (const file of currentAttachments) {
    const existing = attachments.find(item => item.name === file.name);
    if (existing && existing.image === file.image && existing.text === file.text) continue;
    let name = file.name;
    if (existing) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const extension = dot > 0 ? name.slice(dot) : '';
      let suffix = 2;
      do { name = `${stem} (${suffix++})${extension}`; } while (reserved.has(name));
    }
    reserved.add(name); files.add(name);
    attachments.push(name === file.name ? file : { ...file, name });
  }
  return {
    draft: [message.text, draft].filter(Boolean).join('\n\n'),
    context: {
      files: [...files],
      projects: [...new Set([...message.context.projects, ...context.projects])],
      skills: [...new Set([...message.context.skills, ...context.skills])],
      attachments,
    },
  };
}

/** Insert at the target position, preserving the relative order of other entries. */
export function moveQueued(queue: MessageQueue, key: string, id: string, targetId: string): MessageQueue {
  const list = queueFor(queue, key);
  const from = list.findIndex(item => item.id === id);
  const to = list.findIndex(item => item.id === targetId);
  if (from < 0 || to < 0 || from === to) return queue;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return { ...queue, [key]: next };
}

/** Moves one entry to the front so it is sent next (used by "引导"). */
export function promoteQueued(queue: MessageQueue, key: string, id: string): MessageQueue {
  const list = queueFor(queue, key);
  const item = list.find(entry => entry.id === id);
  if (!item || list[0]?.id === id) return queue;
  return { ...queue, [key]: [item, ...list.filter(entry => entry.id !== id)] };
}
