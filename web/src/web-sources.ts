import type { ChatBlock } from './chat';

export type WebSource = { url: string; hostname: string; title?: string };

export function messageWebSources(blocks: readonly ChatBlock[]): WebSource[] {
  const sources = new Map<string, WebSource>();
  const add = (value: unknown, title?: string) => {
    if (typeof value !== 'string') return;
    const raw = value.trim();
    if (!/^https?:\/\/[^/]/i.test(raw) || /[\s\x00-\x1f\x7f\\]/.test(raw)) return;
    try {
      const url = new URL(raw);
      if (url.username || url.password) return;
      const href = url.href;
      url.hash = '';
      const existing = sources.get(url.href);
      if (!existing) sources.set(url.href, { url: href, hostname: url.hostname, ...(title ? { title } : {}) });
      else if (!existing.title && title) existing.title = title;
    } catch { /* The tool result may contain a malformed URL. */ }
  };
  const visit = (items: readonly ChatBlock[]) => {
    for (const block of items) {
      if (block.type === 'sub_agent') {
        visit(block.blocks);
        continue;
      }
      if (block.type !== 'tool_call' || block.name !== 'web' || block.status !== '成功') continue;
      const action = typeof block.args?.action === 'string' ? block.args.action.trim().toLowerCase() : '';
      if (action === 'fetch' || action === 'webfetch') {
        add(block.args?.url);
      } else if (action === 'search' || action === 'websearch' || action === 'code' || action === 'codesearch') {
        // Exa separates result records with a horizontal rule. Read their headers, not links inside excerpts.
        for (const result of block.result?.trimStart().split(/\r?\n---[ \t]*\r?\n(?:[ \t]*\r?\n)*/) ?? []) {
          const header = /^Title:[ \t]*([^\r\n]*)\r?\nURL:[ \t]*([^\r\n]+)\r?\n(?:Published(?: Date)?|Author|Highlights|Text|Code\/Highlights):/i.exec(result);
          if (!header) continue;
          const title = header[1].trim();
          add(header[2], /^N\/A$/i.test(title) ? undefined : title);
        }
      }
    }
  };
  visit(blocks);
  return [...sources.values()];
}
