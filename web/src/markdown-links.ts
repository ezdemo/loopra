// Ported from the legacy `src/utils/highlight.js` link rule: markdown links that
// point at a workspace file path (e.g. `src/app.ts:12`) are opened in the local
// file preview instead of a browser tab.
const LOCAL_FILE_PATH = /^(?:\/?[A-Za-z]:\/|\/)?(?:[\w@.-]+\/)+[\w@.-]+\.[\w-]+(?::\d+(?:-\d+)?)?$/;

// `C:\repo\a.ts` never reaches the component as a href: react-markdown blanks
// unknown "protocols" and the sanitize schema drops them. Links matching a local
// path are rewritten to this scheme before sanitizing, then read back here.
export const LOCAL_FILE_SCHEME = 'loopra-file:';

export function isLocalFilePath(href: string): boolean {
  return LOCAL_FILE_PATH.test(String(href).replace(/\\/g, '/'));
}

export function filePathFromHref(href: string): string {
  return String(href).replace(/\\/g, '/').replace(/^\/(?=[A-Za-z]:\/)/, '').replace(/:\d+(?:-\d+)?$/, '');
}

/** `src/app.ts:12` -> 12, so the body can show the `(line 12)` hint next to the file. */
export function fileLineFromHref(href?: string): number | null {
  const raw = String(href || '').replace(/\\/g, '/');
  const match = /:(\d+)(?:-\d+)?$/.exec(raw.startsWith(LOCAL_FILE_SCHEME) ? raw.slice(LOCAL_FILE_SCHEME.length) : raw);
  return match ? Number(match[1]) : null;
}

/** Workspace-relative or absolute path behind a link, or null when it is a URL. */
export function localFilePath(href?: string): string | null {
  if (!href) return null;
  if (href.startsWith(LOCAL_FILE_SCHEME)) return filePathFromHref(href.slice(LOCAL_FILE_SCHEME.length));
  return isLocalFilePath(href) ? filePathFromHref(href) : null;
}

type HastNode = { type?: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[] };

// Runs between rehype-raw and rehype-sanitize so local paths survive sanitizing.
export function rehypeLocalFileLinks() {
  const visit = (node: HastNode) => {
    const href = node.properties?.href;
    if (node.type === 'element' && node.tagName === 'a' && typeof href === 'string' && LOCAL_FILE_PATH.test(href.replace(/\\/g, '/'))) {
      // The line suffix rides along inside the scheme value so the chip can still
      // render `(line 12)` after sanitizing dropped it from a plain href.
      const line = fileLineFromHref(href);
      node.properties!.href = `${LOCAL_FILE_SCHEME}${filePathFromHref(href)}${line === null ? '' : `:${line}`}`;
      node.properties!.title = '打开文件预览';
    }
    for (const child of node.children || []) visit(child);
  };
  return (tree: HastNode) => visit(tree);
}
