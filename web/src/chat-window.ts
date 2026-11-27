/**
 * Legacy `Chat.vue` message virtualization. Short conversations render every
 * message; long ones mount only the visible slice plus an overscan band, with
 * spacer heights that keep the scroll position stable.
 */
export const ESTIMATED_MESSAGE_HEIGHT = 320;
export const VIRTUAL_OVERSCAN = 1200;
export const VIRTUALIZATION_THRESHOLD = 60;

/** Running top offsets (length `heights.length + 1`) with estimated fallbacks. */
export function messageOffsets(heights: number[]): number[] {
  const offsets = new Array(heights.length + 1).fill(0);
  for (let index = 0; index < heights.length; index++) {
    offsets[index + 1] = offsets[index] + (heights[index] > 0 ? heights[index] : ESTIMATED_MESSAGE_HEIGHT);
  }
  return offsets;
}

const LINE_HEIGHT_ESTIMATE = 24;
const USER_BASE_HEIGHT = 80;
const ASSISTANT_BASE_HEIGHT = 128;
const USER_WIDTH_UNITS = 64;
const ASSISTANT_WIDTH_UNITS = 88;

function visualWidth(line: string) {
  let width = 0;
  for (const char of line) width += (char.codePointAt(0) || 0) > 0xff ? 2 : 1;
  return width;
}

/** Content-aware estimate for an unmounted row. Explicit lines dominate very
 * long answers; wide characters wrap sooner than ASCII text. */
export function estimateMessageHeight(message: { role: 'user' | 'assistant'; text?: string; images?: unknown[] }) {
  const widthUnits = message.role === 'user' ? USER_WIDTH_UNITS : ASSISTANT_WIDTH_UNITS;
  const lines = (message.text || '').split(/\r?\n/).reduce((total, line) => total + Math.max(1, Math.ceil(visualWidth(line) / widthUnits)), 0);
  const base = message.role === 'user' ? USER_BASE_HEIGHT : ASSISTANT_BASE_HEIGHT;
  return base + lines * LINE_HEIGHT_ESTIMATE + (message.images?.length || 0) * 160;
}

export type VirtualMessageWindow = { start: number; end: number; topHeight: number; bottomHeight: number; offsets: number[] };

/**
 * Window of message indices to mount for a scroll offset. Mirrors the legacy
 * `virtualWindow` computed: below the threshold everything is mounted and both
 * spacers are zero, so short sessions behave exactly like a plain list.
 */
export function virtualMessageWindow(heights: number[], scrollTop: number, viewportHeight: number, threshold = VIRTUALIZATION_THRESHOLD): VirtualMessageWindow {
  const total = heights.length;
  const offsets = messageOffsets(heights);
  if (total <= threshold) return { start: 0, end: total, topHeight: 0, bottomHeight: 0, offsets };
  const startOffset = Math.max(0, scrollTop - VIRTUAL_OVERSCAN);
  const endOffset = scrollTop + viewportHeight + VIRTUAL_OVERSCAN;
  let start = 0;
  while (start < total && offsets[start + 1] < startOffset) start++;
  let end = start;
  while (end < total && offsets[end] < endOffset) end++;
  return { start, end, topHeight: offsets[start], bottomHeight: offsets[total] - offsets[end], offsets };
}
