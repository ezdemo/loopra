export type ToolParam = { text: string; title?: string; filePath?: string };

/** Legacy `BlockRenderer.vue` truncated long bash commands at 60 chars. */
const BASH_MAX = 60;
/** Legacy `BlockRenderer.vue` truncated grep/glob paths at 50 chars. */
const PATH_MAX = 50;
/** Legacy `BlockRenderer.vue` truncated the ask_choice question at 40 chars. */
const QUESTION_MAX = 40;
/** Tools whose `file_path` argument opens the workspace diff (legacy `shouldShowOpenFile`). */
const FILE_TOOLS = ['read', 'edit', 'write'];

const truncate = (value: string, max: number) => value.length > max ? value.slice(0, max - 3) + '...' : value;

/** Legacy `getFileName`: last path segment, tolerant of Windows separators. */
export function toolFileName(path: string) {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || path;
}

/**
 * Formats the inline parameter shown on a tool card, mirroring legacy
 * `BlockRenderer.vue` (`getBashCommand` / `getGrepPath` / `getGlobPath` /
 * `getLsPath` / `getChoiceQuestion` / `shouldShowOpenFile`).
 *
 * A returned `filePath` means the card should render a clickable filename that
 * opens the workspace diff for that path.
 */
export function toolParam(name: string, args?: Record<string, unknown>): ToolParam | null {
  const text = (key: string) => (typeof args?.[key] === 'string' ? (args[key] as string) : '');
  const filePath = text('file_path');
  if (filePath && FILE_TOOLS.includes(name)) return { text: toolFileName(filePath), title: filePath, filePath };
  if (name === 'bash' && text('command')) return { text: truncate(text('command'), BASH_MAX), title: text('command') };
  if ((name === 'grep' || name === 'glob') && text('path')) return { text: truncate(text('path'), PATH_MAX), title: text('path') };
  if (name === 'ls' && text('path')) return { text: text('path') };
  if (name === 'ask_choice' && text('question')) {
    const count = Array.isArray(args?.options) ? args!.options!.length : 0;
    const question = text('question');
    return { text: `${truncate(question, QUESTION_MAX)}${count > 0 ? ` (${count} 项)` : ''}` };
  }
  // Generic fallback keeps prior behaviour for every other tool.
  const fallback = text('command') || filePath || text('pattern') || text('path');
  return fallback ? { text: fallback } : null;
}
