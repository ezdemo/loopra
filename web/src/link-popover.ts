// Ported from legacy `ChatMessage.vue` (链接悬停浮层): hovering a markdown link
// shows a small toolbar with "open in browser" (and, on Electron, "元素界面打开").

export const LINK_POPOVER_HIDE_DELAY_MS = 150;
export const LINK_POPOVER_VIEWPORT_MARGIN = 80;

/**
 * Legacy `normalizeActionUrl`: trims trailing punctuation that markdown often
 * glues to a bare URL and only accepts http(s) links.
 */
export function normalizeActionUrl(rawUrl: unknown): string {
  const match = String(rawUrl ?? '').trim().match(/^https?:\/\/[^\s,，。；;！？!?"'`<>()[\]{}]+/i);
  if (!match) return '';
  try {
    const url = new URL(match[0]);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

/** Centers the popover under the hovered link, keeping it inside the viewport. */
export function linkPopoverPosition(rect: { left: number; width: number; bottom: number }, viewportWidth: number, margin = LINK_POPOVER_VIEWPORT_MARGIN) {
  const centerX = rect.left + rect.width / 2;
  return { x: Math.max(margin, Math.min(centerX, viewportWidth - margin)), y: rect.bottom + 4 };
}
