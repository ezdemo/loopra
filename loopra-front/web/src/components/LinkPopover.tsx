import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Globe } from 'lucide-react';
import { LINK_POPOVER_HIDE_DELAY_MS, linkPopoverPosition, normalizeActionUrl } from '../link-popover';

type Popover = { url: string; x: number; y: number };

const LinkPopoverContext = createContext<{ show: (target: HTMLElement) => void; scheduleHide: () => void }>({ show: () => {}, scheduleHide: () => {} });

/** Hover helpers for markdown links; the provider renders the floating toolbar. */
export function useLinkPopover() {
  return useContext(LinkPopoverContext);
}

function electronBridge() {
  return (window as unknown as { electronAPI?: { openExternal?: (url: string) => unknown } }).electronAPI;
}

export function LinkPopoverProvider({ children }: { children?: ReactNode }) {
  const [popover, setPopover] = useState<Popover | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelHide = useCallback(() => { if (timer.current != null) { clearTimeout(timer.current); timer.current = null; } }, []);
  const scheduleHide = useCallback(() => {
    cancelHide();
    timer.current = setTimeout(() => setPopover(null), LINK_POPOVER_HIDE_DELAY_MS);
  }, [cancelHide]);
  const show = useCallback((target: HTMLElement) => {
    cancelHide();
    if (target.dataset.filePath) return;
    const url = normalizeActionUrl(target.getAttribute('href'));
    if (!url) return;
    const rect = target.getBoundingClientRect();
    setPopover({ url, ...linkPopoverPosition(rect, window.innerWidth) });
  }, [cancelHide]);

  useEffect(() => cancelHide, [cancelHide]);

  const openInBrowser = () => {
    const url = popover?.url;
    setPopover(null);
    if (!url) return;
    const bridge = electronBridge();
    if (bridge?.openExternal) void bridge.openExternal(url);
    else window.open(url, '_blank', 'noopener,noreferrer');
  };
  return <LinkPopoverContext.Provider value={{ show, scheduleHide }}>{children}
    {popover && createPortal(
      <div className="link-popover" style={{ left: popover.x, top: popover.y }} onMouseEnter={cancelHide} onMouseLeave={scheduleHide}>
        <button type="button" className="link-popover-btn" onClick={openInBrowser}><Globe size="0.8125rem" />浏览器打开</button>
      </div>,
      document.body,
    )}
  </LinkPopoverContext.Provider>;
}
