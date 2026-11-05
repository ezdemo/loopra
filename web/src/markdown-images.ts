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
