import type { ChatBlock } from './chat';

export type MessageFileStats = { edited: string[]; created: string[] };

/**
 * Legacy `ChatMessage.vue` `fileStats`: `edit` counts as 修改, `write` as 新增,
 * deduped by path and never counted for the `finish` sentinel.
 *
 * Streaming `file_changes` events already carry a `created` flag, so they are
 * folded in first; tool-call arguments fill in turns where only the tool call
 * (and not a `file_changes` summary) was recorded.
 */
export function messageFileStats(blocks: ChatBlock[] = []): MessageFileStats {
  const edited = new Set<string>();
  const created = new Set<string>();
  for (const block of blocks) {
    if (block.type === 'file_changes') {
      for (const change of block.changes) {
        if (change.path) (change.created ? created : edited).add(change.path);
      }
    } else if (block.type === 'tool_call') {
      if (block.name === 'finish') continue;
      const path = typeof block.args?.file_path === 'string' ? block.args.file_path : '';
      if (!path) continue;
      if (block.name === 'edit') edited.add(path);
      else if (block.name === 'write') created.add(path);
    }
  }
  return { edited: [...edited], created: [...created] };
}
