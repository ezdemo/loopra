import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Minus, Square, X } from 'lucide-react';
import { desktopPlatform, desktopWindowApi, usesNativeWindowControls } from '../desktop-shell';

export function DesktopHeaderActions({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const actions = useRef<HTMLDivElement>(null);
  const placeholder = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [dragGap, setDragGap] = useState({ left: 0, width: 0 });
  useLayoutEffect(() => {
    if (desktopWindowApi() && !usesNativeWindowControls(desktopPlatform())) {
      setTarget(document.querySelector<HTMLElement>('.desktop-header-actions'));
    }
  }, []);
  useLayoutEffect(() => {
    if (!target || !actions.current || !placeholder.current) return;
    const element = actions.current;
    const leading = placeholder.current.parentElement?.querySelector<HTMLElement>('.header-leading');
    const measure = () => {
      setWidth(element.getBoundingClientRect().width);
      if (leading && target.parentElement) {
        const left = leading.getBoundingClientRect().right;
        setDragGap({ left, width: Math.max(0, target.parentElement.getBoundingClientRect().left - left) });
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (leading) observer.observe(leading);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [target]);
  const controls = <div className="header-actions" ref={actions}>{children}</div>;
  // Preserve space for the title while the actual controls live at the window edge.
  return target ? <><div className="header-actions-placeholder" ref={placeholder} style={{ width }} aria-hidden="true" />{createPortal(<><div className="desktop-header-drag-gap" style={dragGap} aria-hidden="true" />{controls}</>, target)}</> : controls;
}

// Title bar for the Electron renderer. Renders nothing in the browser (no
// `electronAPI.window`), so the web layout is unchanged. The controls float over
// the sidebar brand / conversation header row, which itself is the drag region;
// on macOS the native traffic lights replace the drawn controls.
export default function DesktopTitleBar() {
  const api = desktopWindowApi();
  const nativeControls = usesNativeWindowControls(desktopPlatform());
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!api || nativeControls) return;
    let active = true;
    void Promise.resolve(api.isMaximized?.()).then(value => { if (active) setMaximized(!!value); }).catch(() => {});
    return () => { active = false; };
  }, [api, nativeControls]);
  if (!api) return null;
  return <header className={`desktop-titlebar${nativeControls ? ' is-native-controls' : ''}`} aria-label="窗口标题栏">
    {!nativeControls && <div className="desktop-header-actions" />}
    {!nativeControls && <div className="desktop-window-controls">
      <button type="button" className="dw-btn" aria-label="最小化窗口" title="最小化" onClick={() => void Promise.resolve(api.minimize?.())}><Minus size={14} /></button>
      <button type="button" className="dw-btn" aria-label={maximized ? '还原窗口' : '最大化窗口'} title={maximized ? '还原' : '最大化'} onClick={() => { setMaximized(value => !value); void Promise.resolve(api.maximize?.()); }}>{maximized ? <Copy size={13} /> : <Square size={12} />}</button>
      <button type="button" className="dw-btn dw-close" aria-label="关闭窗口" title="关闭" onClick={() => void Promise.resolve(api.close?.())}><X size={14} /></button>
    </div>}
  </header>;
}
