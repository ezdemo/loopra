// Dragging the composer's top edge trades chat space for input space. The height
// the stylesheet gives the card is the floor — the default stays the smallest
// size, so a drag can only grow it — and the ceiling keeps the transcript
// readable on short windows. Heights are kept in rem (so they follow
// 设置 → 字号) and per session, so a reopened session returns at its old size.

/** 0 means "the stylesheet default", i.e. the smallest allowed height. */
export const DEFAULT_COMPOSER_HEIGHT_REM = 0;
/** What the stylesheet renders before a drag, used when no floor is readable. */
export const FALLBACK_COMPOSER_FLOOR_REM = 6.5;
/** 20rem is ~320px at the default scale; past that the transcript gets cramped. */
export const MAX_COMPOSER_HEIGHT_REM = 20;
/** A short window must keep the conversation readable: 45% of the viewport. */
export const MAX_COMPOSER_HEIGHT_RATIO = 0.45;
/** One arrow-key press on the handle. */
export const COMPOSER_HEIGHT_STEP_REM = 1;
/** localStorage guard: one entry per touched session, oldest entries dropped. */
export const MAX_STORED_COMPOSER_HEIGHTS = 60;

/** The tallest the card may become, in rem, for this window and type scale. */
export function composerHeightCeiling(viewportHeight: number, rootFontSize = 16, floorRem = 0): number {
  const rem = Number.isFinite(rootFontSize) && rootFontSize > 0 ? rootFontSize : 16;
  const viewport = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 800;
  return Math.max(floorRem, Math.min(MAX_COMPOSER_HEIGHT_REM, (viewport * MAX_COMPOSER_HEIGHT_RATIO) / rem));
}

/** Never shorter than the default (`floorRem`) nor taller than the ceiling. */
export function clampComposerHeight(heightRem: number, floorRem: number, ceilingRem: number): number {
  const floor = Number.isFinite(floorRem) && floorRem > 0 ? floorRem : 0;
  const ceiling = Math.max(floor, Number.isFinite(ceilingRem) ? ceilingRem : MAX_COMPOSER_HEIGHT_REM);
  const height = Number.isFinite(heightRem) ? heightRem : floor;
  // cm precision keeps the stored value readable and the style string short.
  return Math.round(Math.min(Math.max(height, floor), ceiling) * 100) / 100;
}

// Dragging the top edge upwards (negative delta) makes the card taller.
export function resizeComposerHeight(startHeightRem: number, pointerDeltaY: number, rootFontSize: number, floorRem: number, ceilingRem: number): number {
  const rem = Number.isFinite(rootFontSize) && rootFontSize > 0 ? rootFontSize : 16;
  return clampComposerHeight(startHeightRem - pointerDeltaY / rem, floorRem, ceilingRem);
}

/** Arrow-key stepping on the focused handle. */
export function nudgeComposerHeight(currentHeightRem: number, deltaRem: number, floorRem: number, ceilingRem: number): number {
  return clampComposerHeight(currentHeightRem + deltaRem, floorRem, ceilingRem);
}

/** Home drafts belong to the workspace; a saved session to its own name. */
export function composerSessionKey(workspaceHash: string, sessionName?: string): string {
  return `${workspaceHash || ''}/${sessionName || ''}`;
}

/**
 * A missing, zero or invalid entry falls back to the stylesheet default, so a
 * reset drops the stored height instead of pinning today's default forever.
 * Stored values are also re-clamped on read: localStorage outlives a type-scale
 * change, and it can be edited by hand.
 */
export function composerHeight(heights: Record<string, number> | undefined, key: string): number {
  const saved = heights?.[key];
  if (typeof saved !== 'number' || !Number.isFinite(saved) || saved <= 0) return DEFAULT_COMPOSER_HEIGHT_REM;
  return clampComposerHeight(saved, 0, MAX_COMPOSER_HEIGHT_REM);
}

/**
 * Store a height for one session. Re-inserting moves the key to the end so the
 * least recently used sessions are the ones dropped once the map hits its cap;
 * a non-positive height removes the entry (back to the default).
 */
export function storeComposerHeight(heights: Record<string, number>, key: string, heightRem: number): Record<string, number> {
  const next = { ...heights };
  delete next[key];
  if (!(heightRem > 0)) return next;
  next[key] = clampComposerHeight(heightRem, 0, MAX_COMPOSER_HEIGHT_REM);
  const keys = Object.keys(next);
  const overflow = keys.length - MAX_STORED_COMPOSER_HEIGHTS;
  for (const stale of keys.slice(0, Math.max(0, overflow))) delete next[stale];
  return next;
}
