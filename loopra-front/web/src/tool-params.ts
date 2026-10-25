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

/** Image-reader titles may include their path, e.g. `View Image C:\\...\\screen.png`. */
export function imageToolSources(name: string, args?: Record<string, unknown>): string[] {
  const imageReader = /(?:^|[.:/_\s])(?:view[ _-]?image|read[ _-]?image)(?=$|[\s.:/_-])/i.test(name);
  const fileReader = /^(?:read|readfile)(?:$|\s)/i.test(name);
  if (!imageReader && !fileReader) return [];
  const paths = ['path', 'file_path', 'filePath', 'image_path', 'imagePath', 'paths', 'files']
    .flatMap(key => Array.isArray(args?.[key]) ? args![key] as unknown[] : [args?.[key]])
    .filter((value): value is string => typeof value === 'string' && /\.(?:png|jpe?g|gif|webp)$/i.test(value));
  if (imageReader && !paths.length) {
    const fromTitle = name.match(/(?:view[ _-]?image|read[ _-]?image)\s+(.+\.(?:png|jpe?g|gif|webp))$/i)?.[1];
    if (fromTitle) paths.push(fromTitle.replace(/^["']|["']$/g, ''));
  }
  if (imageReader && typeof args?.url === 'string' && /^https?:\/\//i.test(args.url)) paths.push(args.url);
  if (imageReader && typeof args?.base64 === 'string') {
    const value = args.base64;
    if (/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(value)) paths.push(value);
    else if (/^[a-z0-9+/=\s]+$/i.test(value)) {
      const mime = value.startsWith('iVBOR') ? 'png' : value.startsWith('/9j/') ? 'jpeg' : value.startsWith('R0lGOD') ? 'gif' : value.startsWith('UklGR') ? 'webp' : '';
      if (mime) paths.push(`data:image/${mime};base64,${value}`);
    }
  }
  return [...new Set(paths)].slice(0, 8);
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
