import { useEffect, useRef, useState } from 'react';
import { Button } from '@nextui-org/react';
import { animate, motion, useMotionValue, useTransform } from 'framer-motion';
import { Folder, MessageSquare, Plus } from 'lucide-react';
import { useAppMotion } from '@web/components/Motion';
import LiquidGlass from './LiquidGlass';

type Tab = 'threads' | 'projects';
const spring = { type: 'spring' as const, stiffness: 480, damping: 34, mass: .65 };
export default function LiquidNavigation({ page, onPage, onNew, disabled }: { page: Tab; onPage: (page: Tab) => void; onNew: () => void; disabled: boolean }) {
  const { enabled } = useAppMotion();
  const nav = useRef<HTMLElement>(null);
  const add = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ pointerId: number; x: number; start: number; moved: boolean }>();
  const [pressed, setPressed] = useState(false);
  const offset = useMotionValue(0);
  useEffect(() => () => offset.stop(), [offset]);
  const stretch = useTransform(offset, [-60, 0, 60], [1.13, 1, 1.13]);
  const shift = (clientX: number) => {
    const node = nav.current; if (!node) return 0;
    const rect = node.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left - 6) / (rect.width - 12))) * 2 - 1;
  };
  const finish = (cancelled: boolean) => {
    const current = drag.current; drag.current = undefined; setPressed(false);
    if (!current) return;
    if (!cancelled && current.moved) onPage(current.x >= 0 ? 'projects' : 'threads');
    animate(offset, 0, enabled ? spring : { duration: 0 });
  };
  return <div className="phone-bottom">
    <motion.nav ref={nav} className="phone-liquid-nav" aria-label="主要导航" animate={enabled ? { scale: pressed ? 1.025 : 1 } : { scale: 1 }} transition={spring} onPointerDown={event => {
      if (event.button !== 0) return;
      const x = shift(event.clientX); drag.current = { pointerId: event.pointerId, x, start: event.clientX, moved: false }; setPressed(true);
      nav.current?.style.setProperty('--phone-light-x', `${(x + 1) * 50}%`);
    }} onPointerMove={event => {
      const current = drag.current; if (!current || current.pointerId !== event.pointerId) return;
      current.x = shift(event.clientX);
      nav.current?.style.setProperty('--phone-light-x', `${(current.x + 1) * 50}%`);
      if (Math.abs(event.clientX - current.start) > 8) {
        current.moved = true; nav.current?.setPointerCapture(event.pointerId);
        const rect = nav.current!.getBoundingClientRect();
        const position = (current.x + 1) * (rect.width - 12) / 2;
        offset.set(position - (page === 'threads' ? .25 : .75) * (rect.width - 12));
      }
    }} onPointerUp={() => finish(false)} onPointerCancel={() => finish(true)} onLostPointerCapture={() => { if (drag.current) finish(true); }} data-pressed={pressed}>
      <LiquidGlass target={nav} />
      <motion.span className="phone-liquid-selection" aria-hidden="true" animate={{ left: page === 'threads' ? '0%' : '50%' }} transition={enabled ? spring : { duration: 0 }} style={{ x: offset, scaleX: enabled ? stretch : 1 }} />
      {([{ id: 'threads', label: '会话', Icon: MessageSquare }, { id: 'projects', label: '项目', Icon: Folder }] as const).map(({ id, label, Icon }) => <Button key={id} variant="light" disableRipple aria-current={page === id ? 'page' : undefined} onPress={() => { if (!drag.current?.moved) onPage(id); }}><span className="phone-nav-label"><Icon size={21} strokeWidth={page === id ? 2.2 : 1.8} />{label}</span></Button>)}
    </motion.nav>
    <Button ref={add} isIconOnly variant="light" className="phone-new phone-liquid-button" aria-label="新建会话" isDisabled={disabled} onPress={onNew}><LiquidGlass target={add} /><span className="phone-nav-label"><Plus size={26} /></span></Button>
  </div>;
}
