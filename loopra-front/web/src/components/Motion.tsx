import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { NextUIProvider } from '@nextui-org/react';
import { MotionGlobalConfig } from 'framer-motion';

const MotionContext = createContext({ enabled: true });
const reducedQuery = '(prefers-reduced-motion: reduce)';
function subscribeReducedMotion(listener: () => void) {
  const media = window.matchMedia(reducedQuery);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}
export function useAppMotion() {
  return useContext(MotionContext);
}

/** Slide length for the docked sidebars; mirrors `--panel-slide-duration` in motion.css. */
export const PANEL_SLIDE_MS = 300;

/**
 * Keep a surface mounted while it animates out. The sidebars slide both ways, so
 * the closing element has to survive its own exit transition; it is dropped once
 * that finishes. With motion off there is nothing to play, so the node goes at once.
 */
export function usePresence(open: boolean): boolean {
  const { enabled } = useAppMotion();
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) { setMounted(true); return undefined; }
    if (!mounted) return undefined;
    const timer = setTimeout(() => setMounted(false), enabled ? PANEL_SLIDE_MS : 0);
    return () => clearTimeout(timer);
  }, [open, mounted, enabled]);
  return mounted;
}

export function AppMotion({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const reduced = useSyncExternalStore(subscribeReducedMotion, () => window.matchMedia(reducedQuery).matches);
  const active = enabled && !reduced;
  // Include NextUI portals as well as the application shell in the CSS preference.
  useLayoutEffect(() => {
    const previous = MotionGlobalConfig.skipAnimations;
    // NextUI 2.6 only ever sets skipAnimations to true. Own both directions so
    // re-enabling animations works, and keep modal portal/focus trees stable.
    MotionGlobalConfig.skipAnimations = !active;
    document.documentElement.dataset.motion = active ? 'on' : 'off';
    return () => { MotionGlobalConfig.skipAnimations = previous; };
  }, [active]);
  return <MotionContext.Provider value={{ enabled: active }}>
    <NextUIProvider skipFramerMotionAnimations={false} disableAnimation={!active} disableRipple={!active} reducedMotion={active ? 'user' : 'always'}>
      {children}
    </NextUIProvider>
  </MotionContext.Provider>;
}

// Custom surfaces update immediately; NextUI owns component animations.
export function Popup({ open, children, className, role }: { open: boolean; children: ReactNode; className: string; role?: string }) {
  return open ? <div role={role} className={className}>{children}</div> : null;
}

export function Collapse({ open, children, className, id }: { open: boolean; children: ReactNode; className?: string; id?: string }) {
  return open ? <div className="content-collapse"><div id={id} className={className}>{children}</div></div> : null;
}

/** Legacy `loopra:collapse-all-blocks` bridge: the chat toolbar folds every block. */
export function useCollapseAll(collapse: () => void) {
  const handler = useRef(collapse);
  useEffect(() => { handler.current = collapse; });
  useEffect(() => {
    const listener = () => handler.current();
    window.addEventListener('loopra:collapse-all-blocks', listener);
    return () => window.removeEventListener('loopra:collapse-all-blocks', listener);
  }, []);
}

export function Disclosure({ children, heading, className, headingClass = 'disclosure-heading' }: { children: ReactNode; heading: ReactNode; className: string; headingClass?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  useCollapseAll(() => setOpen(false));
  return <div className={className} data-open={open}>
    <button type="button" className={headingClass} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{heading}</button>
    <Collapse open={open} id={id}>{children}</Collapse>
  </div>;
}

export function Enter({ children, className, as: Component = 'div', style, 'aria-label': label, 'data-message-id': messageId }: { children: ReactNode; className?: string; as?: 'div' | 'article' | 'section'; style?: CSSProperties; 'aria-label'?: string; 'data-message-id'?: string }) {
  return <Component aria-label={label} className={className} style={style} data-message-id={messageId}>{children}</Component>;
}

export function SidebarSurface({ open, width, children }: { open: boolean; width?: number; children: ReactNode }) {
  // The width is inline because it follows a drag; `--sidebar-width` lets the
  // closed state slide exactly that far off-screen.
  return <aside className="sidebar" data-open={open}
    style={width ? ({ width, flexBasis: width, '--sidebar-width': `${width}px` } as CSSProperties) : undefined} aria-label="工作区和会话">{children}</aside>;
}

export function Toast({ message, children }: { message: string; children: ReactNode }) {
  return <div className="toast-region">{message && <div className="toast"><span role="status">{children}</span></div>}</div>;
}

export function SelectionIndicator() {
  return <span className="selection-indicator" aria-hidden="true" />;
}
