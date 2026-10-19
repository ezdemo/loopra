import type { QueuedMessage } from './composer';

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

/** Moves one entry to the front so it is sent next (used by "引导"). */
export function promoteQueued(queue: MessageQueue, key: string, id: string): MessageQueue {
  const list = queueFor(queue, key);
  const item = list.find(entry => entry.id === id);
  if (!item || list[0]?.id === id) return queue;
  return { ...queue, [key]: [item, ...list.filter(entry => entry.id !== id)] };
}
