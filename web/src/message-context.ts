import type { MessageDocument } from './chat';

export type MessageContextItem = { kind: 'document' | 'skill' | 'file' | 'paste' | 'context'; name: string; content: string; size?: number };

/** Interpret composer sections only; preserve server notes and unknown formats. */
export function messageContextItems(context: string, documents: MessageDocument[]): MessageContextItem[] {
  const items: MessageContextItem[] = documents.map(file => ({ kind: 'document', name: file.name, content: file.text, size: file.size }));
  for (const section of context.split(/\r?\n\s*\r?\n/).filter(part => part.trim())) {
    const [heading, ...lines] = section.split(/\r?\n/);
    if (heading === '调用技能：' && lines.length && lines.every(line => /^\/skill:.+/.test(line))) {
      items.push(...lines.map(line => ({ kind: 'skill' as const, name: line.slice('/skill:'.length), content: line })));
      continue;
    }
    const kind = heading === '引用文件：' ? 'file' : /^大段(?:粘贴|输入)内容（已保存）：$/.test(heading) ? 'paste' : undefined;
    if (kind && lines.some(line => line.startsWith('- '))) {
      const notes = lines.filter(line => !line.startsWith('- ')).join('\n');
      items.push(...lines.filter(line => line.startsWith('- ')).map((line): MessageContextItem => {
        const path = line.slice(2);
        return { kind, name: path.split(/[\\/]/).pop() || path, content: [path, notes].filter(Boolean).join('\n\n') };
      }));
      continue;
    }
    items.push({ kind: 'context', name: '上下文', content: section });
  }
  return items;
}
