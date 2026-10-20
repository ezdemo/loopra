import { useLayoutEffect, useState, type RefObject } from 'react';

export type MenuPlacement = { side: 'top' | 'bottom'; maxHeight: number };
/** The box the popup can actually paint inside: the clipping ancestors' box. */
export type MenuBounds = { top: number; bottom: number };

/** Matches the `0.4375rem` gap between an anchor and its popup. */
export const MENU_GAP = 7;
/** Keep a little air between the popup and the edge of its clipping box. */
export const MENU_VIEWPORT_MARGIN = 8;
/** Heading, divider, footer and a few rows — below this the menu is not usable.
 *  In rem so the app's UI scale applies; the hook converts it to pixels. */
export const MENU_MIN_SIDE_REM = 11;

/**
 * Upward is the natural direction for the bottom-anchored switcher, so keep it
 * unless the room above cannot fit a usable menu; only then flip below (and
 * only if that side really has more room). The returned height caps the popup
 * on the chosen side, so the list scrolls instead of being clipped.
 */
export function computeMenuPlacement(anchor: { top: number; bottom: number }, bounds: MenuBounds, gap = MENU_GAP, margin = MENU_VIEWPORT_MARGIN, minimumHeight = MENU_MIN_SIDE_REM * 16): MenuPlacement {
  const above = Math.max(0, anchor.top - gap - margin - bounds.top);
  const below = Math.max(0, bounds.bottom - anchor.bottom - gap - margin);
  const side = above >= minimumHeight || below <= above ? 'top' : 'bottom';
  return { side, maxHeight: side === 'top' ? above : below };
}

/**
 * The popup is absolutely positioned, so its ancestors clip it: the home pane
 * (`workspace-chat-view`) is `overflow: hidden` starting below the header.
 * Measuring against the window would let the menu slide under that clip and
 * lose its heading, so intersect every clipping ancestor instead.
 */
export function measureMenuBounds(element: HTMLElement, viewportHeight: number): MenuBounds {
  const bounds = { top: 0, bottom: viewportHeight };
  // An unset computed value (jsdom) behaves like `visible`.
  const clips = (value: string) => !!value && value !== 'visible';
  for (let node = element.parentElement; node; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    if (!clips(style.overflow) && !clips(style.overflowX) && !clips(style.overflowY)) continue;
    const rect = node.getBoundingClientRect();
    // jsdom and display:none ancestors report an empty rect; ignore them.
    if (!rect.width && !rect.height) continue;
    bounds.top = Math.max(bounds.top, rect.top);
    bounds.bottom = Math.min(bounds.bottom, rect.bottom);
  }
  return bounds;
}

/** Placement for a menu that is mounted only while it is open. */
export function useMenuPlacement(open: boolean, anchorRef: RefObject<HTMLElement>): MenuPlacement {
  const [placement, setPlacement] = useState<MenuPlacement>({ side: 'top', maxHeight: 0 });
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const rootFontSize = parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
      const bounds = measureMenuBounds(anchor, window.innerHeight);
      const next = computeMenuPlacement(anchor.getBoundingClientRect(), bounds, MENU_GAP, MENU_VIEWPORT_MARGIN, MENU_MIN_SIDE_REM * rootFontSize);
      // Scrolling inside the popup also reaches this listener; keep the old
      // object when nothing moved so it does not re-render per scroll event.
      setPlacement(previous => previous.side === next.side && previous.maxHeight === next.maxHeight ? previous : next);
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, anchorRef]);
  return placement;
}
