import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useAppMotion } from '@web/components/Motion';

type Gesture = {
  id: number;
  startY: number;
  lastY: number;
  lastTime: number;
  velocity: number;
  node: HTMLElement;
};

const upwardsResistance = 0.24;
const upwardsLimit = 64;

export default function MobileSheetGrip({ onDismiss }: { onDismiss: () => void }) {
  const { enabled } = useAppMotion();
  const gesture = useRef<Gesture | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const [active, setActive] = useState(false);

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  function release(node: HTMLElement, delay = 0) {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      node.style.transition = '';
      node.style.transform = '';
      node.style.opacity = '';
      node.classList.remove('is-sheet-dragging');
    }, delay);
  }

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (timer.current) return;
    const node = event.currentTarget.closest('.phone-sheet') as HTMLElement | null;
    if (!node) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    node.style.transition = 'none';
    node.classList.add('is-sheet-dragging');
    gesture.current = { id: event.pointerId, startY: event.clientY, lastY: event.clientY, lastTime: performance.now(), velocity: 0, node };
    setActive(true);
  }

  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    const now = performance.now();
    const elapsed = Math.max(1, now - current.lastTime);
    current.velocity = current.velocity * .6 + ((event.clientY - current.lastY) / elapsed) * .4;
    current.lastY = event.clientY;
    current.lastTime = now;
    const raw = event.clientY - current.startY;
    const offset = raw >= 0 ? raw : Math.max(-upwardsLimit, raw * upwardsResistance);
    current.node.style.transform = `translate3d(0, ${offset}px, 0)`;
  }

  function pointerUp(event: ReactPointerEvent<HTMLDivElement>, cancelled = false) {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    gesture.current = undefined;
    setActive(false);
    const raw = event.clientY - current.startY;
    const stale = performance.now() - current.lastTime > 90;
    const velocity = stale ? 0 : current.velocity;
    const threshold = Math.min(132, Math.max(72, current.node.offsetHeight * .28));
    const dismiss = !cancelled && raw > 20 && (raw > threshold || velocity > .65);
    if (dismiss) {
      current.node.style.transition = enabled ? 'transform .2s cubic-bezier(.32,0,.67,0), opacity .18s ease' : 'none';
      current.node.style.transform = 'translate3d(0, 110%, 0)';
      current.node.style.opacity = '0';
      if (enabled) timer.current = window.setTimeout(onDismiss, 160);
      else onDismiss();
      return;
    }
    current.node.style.transition = enabled ? 'transform .3s cubic-bezier(.22,1,.36,1)' : 'none';
    current.node.style.transform = 'translate3d(0, 0, 0)';
    release(current.node, enabled ? 320 : 0);
  }

  return <div
    className="phone-sheet-grip"
    data-active={active ? 'true' : undefined}
    aria-hidden="true"
    onPointerDown={pointerDown}
    onPointerMove={pointerMove}
    onPointerUp={event => pointerUp(event)}
    onPointerCancel={event => pointerUp(event, true)}
  ><span /></div>;
}
