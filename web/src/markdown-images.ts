// Images also use bare filenames, spaces and non-ASCII paths, unlike file links.
export const LOCAL_IMAGE_SCHEME = 'loopra-image:';

export function localImagePath(source: string): string | null {
  let path = source;
  if (path.startsWith(LOCAL_IMAGE_SCHEME)) {
    try { path = decodeURIComponent(path.slice(LOCAL_IMAGE_SCHEME.length)); }
    catch { return null; }
  }
  if (!path.trim() || /[\u0000-\u001f\u007f]/.test(path) || /^[\\/]{2}/.test(path)) return null;
  path = path.replace(/\\/g, '/').replace(/^\/(?=[A-Za-z]:\/)/, '');
  if (!/^[A-Za-z]:\//.test(path) && /^[A-Za-z][\w+.-]*:/.test(path)) return null;
  if (/^[?#]/.test(path)) return null;
  return path;
}

export function isDirectImage(source: string): boolean {
  return /^https?:\/\//i.test(source) || /^data:image\/(?:png|jpeg|gif|webp|bmp|x-ms-bmp|avif);base64,[a-z0-9+/=]+$/i.test(source);
}

type MarkdownNode = {
  type: string; url?: string; children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

const MARKDOWN_PUNCTUATION = /[\u0021-\u002f\u003a-\u0040\u005b-\u0060\u007b-\u007e]/;

function originalWindowsDestination(markdown: string, url: string): string | null {
  for (const opening of markdown.matchAll(/(?:\]\(|\]:)\s*<?/g)) {
    const start = opening.index + opening[0].length;
    let offset = start, index = 0;
    // Walk the raw spelling alongside the parsed URL, undoing only the escapes
    // CommonMark consumes while retaining the original directory separators.
    for (; index < url.length; index++, offset++) {
      if (markdown[offset] === '\\' && MARKDOWN_PUNCTUATION.test(markdown[offset + 1] || '')) offset++;
      if (markdown[offset] !== url[index]) break;
    }
    if (index === url.length && (offset === markdown.length || /[\s)>]/.test(markdown[offset]))) return markdown.slice(start, offset);
  }
  return null;
}

// CommonMark consumes backslashes before punctuation, so `C:\user\.loopra`
// becomes `C:\user.loopra` before rehype sees it. Recover only parsed Windows
// image and reference destinations from their source, leaving code and escaped
// image syntax alone. Shared definitions remain usable as ordinary file links.
export function remarkLocalImages() {
  return (tree: MarkdownNode, file: { value: unknown }) => {
    const source = String(file.value);
    const visit = (node: MarkdownNode) => {
      if ((node.type === 'image' || node.type === 'definition') && node.url && /^\/?[A-Za-z]:/.test(node.url)) {
        const start = node.position?.start.offset, end = node.position?.end.offset;
        if (start !== undefined && end !== undefined) {
          const raw = originalWindowsDestination(source.slice(start, end), node.url);
          if (raw && /^\/?[A-Za-z]:\\/.test(raw)) node.url = raw.replace(/\\+/g, '/');
        }
      }
      for (const child of node.children || []) visit(child);
    };
    visit(tree);
  };
}

type HastNode = { type?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] };

// Protect drive letters before sanitizing; the private scheme never reaches an
// img element. Markdown URI escaping is decoded once, then encoded for transport.
export function rehypeLocalImages() {
  const visit = (node: HastNode) => {
    const src = node.properties?.src;
    if (node.type === 'element' && node.tagName === 'img' && typeof src === 'string' && !isDirectImage(src)) {
      let decoded = src;
      if (!src.startsWith(LOCAL_IMAGE_SCHEME)) {
        try { decoded = decodeURIComponent(src); } catch { /* A literal percent is a valid filename character. */ }
      }
      const path = localImagePath(decoded);
      node.properties!.src = path === null ? '' : `${LOCAL_IMAGE_SCHEME}${encodeURIComponent(path)}`;
    }
    for (const child of node.children || []) visit(child);
  };
  return (tree: HastNode) => visit(tree);
}
