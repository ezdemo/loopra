import { motion } from 'framer-motion';
import { Folder, MessageSquare, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { useAppMotion } from '@web/components/Motion';
import { clampDockThumb, dockPageAt } from '../dock-drag';

type Tab = 'threads' | 'projects';
const TABS = [{ id: 'threads', label: '会话', Icon: MessageSquare }, { id: 'projects', label: '项目', Icon: Folder }] as const;
const spring = { type: 'spring' as const, stiffness: 430, damping: 38, mass: .8 };
const dragStart = 5;

/** Keep the glass surface in CSS: SVG displacement breaks backdrop compositing in Android WebView. */
export default function MobileDock({ page, onPage, onNew, disabled }: { page: Tab; onPage: (page: Tab) => void; onNew: () => void; disabled: boolean }) {
  const { enabled } = useAppMotion();
  const tabs = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number; id: number; base: number; step: number; width: number; dragging: boolean } | undefined>(undefined);
  const dragged = useRef(false);
  const [geometry, setGeometry] = useState({ width: 0, step: 0 });
  const [dragX, setDragX] = useState<number>();
  const [pressed, setPressed] = useState(false);
  const [glowX, setGlowX] = useState('50%');

  useEffect(() => {
    const node = tabs.current;
    if (!node) return;
    const measure = () => {
      const width = node.getBoundingClientRect().width;
      const gap = Number.parseFloat(getComputedStyle(node).columnGap) || 0;
      const thumb = Math.max(0, (width - gap) / 2);
      setGeometry({ width: thumb, step: Math.max(0, width - thumb) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const restingX = page === 'projects' ? geometry.step : 0;
  const thumbX = dragX ?? restingX;
  const visualPage: Tab = dragX === undefined ? page : dockPageAt(dragX, geometry.step);

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    const node = tabs.current;
    if (!node) return;
    const width = node.getBoundingClientRect().width;
    const gap = Number.parseFloat(getComputedStyle(node).columnGap) || 0;
    const thumb = Math.max(0, (width - gap) / 2);
    const step = Math.max(0, width - thumb);
    setGeometry({ width: thumb, step });
    const thumbLeft = node.getBoundingClientRect().left + (page === 'projects' ? step : 0);
    const onThumb = event.clientX >= thumbLeft && event.clientX <= thumbLeft + thumb;
    setPressed(onThumb);
    if (onThumb) setGlowX(`${thumb ? Math.min(1, Math.max(0, (event.clientX - thumbLeft) / thumb)) * 100 : 50}%`);
    start.current = { x: event.clientX, y: event.clientY, id: event.pointerId, base: page === 'projects' ? step : 0, step, width: thumb, dragging: false };
    dragged.current = false;
  }
  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = start.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (!gesture.dragging) {
      if (Math.abs(dx) < dragStart || Math.abs(dx) <= Math.abs(dy)) return;
      gesture.dragging = true;
      setPressed(true);
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const x = clampDockThumb(gesture.base + dx, gesture.step);
    setDragX(x);
    if (gesture.dragging) {
      const left = tabs.current?.getBoundingClientRect().left || 0;
      setGlowX(`${gesture.width ? Math.min(1, Math.max(0, (event.clientX - left - x) / gesture.width)) * 100 : 50}%`);
    }
  }
  function pointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const gesture = start.current;
    start.current = undefined;
    if (!gesture || gesture.id !== event.pointerId) return;
    setPressed(false);
    if (!gesture.dragging) return;
    const x = clampDockThumb(gesture.base + event.clientX - gesture.x, gesture.step);
    setDragX(undefined);
    dragged.current = true;
    const next = dockPageAt(x, gesture.step);
    if (next !== page) onPage(next);
    window.setTimeout(() => { dragged.current = false; }, 0);
  }
  function pointerCancel() {
    start.current = undefined;
    setDragX(undefined);
    setPressed(false);
  }
  function guardClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (!dragged.current) return;
    event.preventDefault();
    event.stopPropagation();
    dragged.current = false;
  }

  return <div className="mobile-dock">
    <div className="mobile-dock-glass">
      <nav className="mobile-dock-inner" aria-label="主要导航">
        <div ref={tabs} className="mobile-dock-tabs" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerCancel} onPointerLeave={() => { if (!start.current?.dragging) { start.current = undefined; setPressed(false); } }} onClickCapture={guardClick}>
          <motion.span className="mobile-dock-selection" aria-hidden="true" data-active={pressed ? 'true' : undefined} initial={false} animate={{ x: thumbX, scaleX: pressed ? 1.02 : 1, scaleY: pressed ? .975 : 1 }} transition={dragX !== undefined ? { duration: 0 } : enabled ? spring : { duration: 0 }} style={{ ...(geometry.width ? { width: geometry.width } : {}), '--dock-glow-x': glowX } as CSSProperties} />
          {TABS.map(({ id, label, Icon }) => <button key={id} type="button" className="mobile-dock-tab" data-visual-active={visualPage === id ? 'true' : undefined} aria-current={page === id ? 'page' : undefined} onClick={() => onPage(id)}>
            <Icon size={20} strokeWidth={visualPage === id ? 2.15 : 1.8} />
            <span>{label}</span>
          </button>)}
        </div>
        <span className="mobile-dock-divider" aria-hidden="true" />
        <button type="button" className="mobile-dock-create" aria-label="新建会话" disabled={disabled} onClick={onNew}>
          <Plus size={23} strokeWidth={2.2} />
        </button>
      </nav>
    </div>
  </div>;
}
