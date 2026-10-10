import { createContext, useContext, useId, useLayoutEffect, useState, useSyncExternalStore } from 'react';
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

export function Disclosure({ children, heading, className, headingClass = 'disclosure-heading' }: { children: ReactNode; heading: ReactNode; className: string; headingClass?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return <div className={className} data-open={open}>
    <button type="button" className={headingClass} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{heading}</button>
    <Collapse open={open} id={id}>{children}</Collapse>
  </div>;
}

export function Enter({ children, className, as: Component = 'div', style, 'aria-label': label }: { children: ReactNode; className?: string; as?: 'div' | 'article' | 'section'; style?: CSSProperties; 'aria-label'?: string }) {
  return <Component aria-label={label} className={className} style={style}>{children}</Component>;
}

export function SidebarSurface({ children }: { children: ReactNode }) {
  return <aside className="sidebar" aria-label="工作区和会话">{children}</aside>;
}

export function Toast({ message, children }: { message: string; children: ReactNode }) {
  return <div className="toast-region">{message && <div className="toast"><span role="status">{children}</span></div>}</div>;
}

export function SelectionIndicator() {
  return <span className="selection-indicator" aria-hidden="true" />;
}
