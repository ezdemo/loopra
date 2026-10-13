import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { RotateCcw, X } from 'lucide-react';
import { clampPetOffset, petAnimations, placePetPanel, type PetAnimation, type PetPoint, type PetReply, type PetSize } from '../pets';
import PetSprite from './PetSprite';

type Props = {
  src: string; name: string; scale: number; activity: PetAnimation;
  position?: PetPoint; reply: PetReply | null; latestReply: string; hidden?: boolean;
  onMove: (position: PetPoint) => Promise<void>; onResize: (scale: number) => Promise<void>;
  onClose: () => void; onError: (message: string) => void;
};
type Layout = { origin: PetPoint; viewport: PetSize };
type Drag = { id: number; x: number; y: number; position: PetPoint };

export default function PetCompanion(props: Props) {
  const anchor = useRef<HTMLSpanElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const avatar = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const slider = useRef<HTMLInputElement>(null);
  const panelId = useId();
  const [layout, setLayout] = useState<Layout | null>(null);
  const [position, setPosition] = useState(props.position || { x: 0, y: 0 });
  const [scale, setScale] = useState(props.scale);
  const [dragging, setDragging] = useState<PetAnimation | null>(null);
  const [action, setAction] = useState<PetAnimation>('idle');
  const [controls, setControls] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [speech, setSpeech] = useState('');
  const [panelPosition, setPanelPosition] = useState<PetPoint>({ x: 8, y: 8 });
  const [bubblePosition, setBubblePosition] = useState<PetPoint>({ x: 8, y: 8 });
  const drag = useRef<Drag | null>(null);
  const dragged = useRef(false);
  const consumed = useRef(false);
  const longPress = useRef<ReturnType<typeof setTimeout>>();
  const actionTimer = useRef<ReturnType<typeof setTimeout>>();
  const speechTimer = useRef<ReturnType<typeof setTimeout>>();
  const positionRef = useRef(position);
  const scaleRef = useRef(scale);
  const savedScale = useRef(props.scale);
  const scaleEditing = useRef(false);
  const saveVersion = useRef(0);
  const size = { width: 192 * scale * 0.75, height: 208 * scale * 0.75 };
  const offset = layout ? clampPetOffset(position, layout.origin, size, layout.viewport) : position;
  positionRef.current = offset;

  useEffect(() => {
    if (!drag.current) { const next = props.position || { x: 0, y: 0 }; setPosition(next); positionRef.current = next; }
  }, [props.position?.x, props.position?.y]);
  useEffect(() => {
    savedScale.current = props.scale;
    if (!scaleEditing.current) { setScale(props.scale); scaleRef.current = props.scale; }
  }, [props.scale]);
  useLayoutEffect(() => {
    const measure = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      setLayout({ origin: { x: rect.left, y: rect.top }, viewport: { width: window.innerWidth, height: window.innerHeight } });
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const element of [anchor.current, anchor.current?.closest('.composer'), anchor.current?.closest('.main-area')]) if (element) observer.observe(element);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [scale]);
  useLayoutEffect(() => {
    if (!layout) return;
    const rect = { x: layout.origin.x + offset.x, y: layout.origin.y + offset.y, ...size };
    const measure = () => {
      if (panel.current) setPanelPosition(placePetPanel(rect, panel.current.getBoundingClientRect(), layout.viewport));
      if (bubble.current) setBubblePosition(placePetPanel(rect, bubble.current.getBoundingClientRect(), layout.viewport));
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (panel.current) observer.observe(panel.current);
    if (bubble.current) observer.observe(bubble.current);
    return () => observer.disconnect();
  }, [layout, offset.x, offset.y, scale, controls, confirmClose, speech]);
  useEffect(() => {
    if (!controls && !speech) return;
    const outside = (event: globalThis.PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) { setControls(false); setConfirmClose(false); }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation(); event.preventDefault(); setControls(false); setConfirmClose(false); setSpeech(''); avatar.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); };
  }, [controls, speech]);
  useEffect(() => {
    if (controls && !confirmClose) slider.current?.focus({ preventScroll: true });
  }, [controls, confirmClose]);
  useEffect(() => {
    if (props.reply?.text) { say(props.reply.text); play(props.reply.activity || 'waving'); }
  }, [props.reply?.id]);
  useEffect(() => {
    if (props.hidden) { setControls(false); setConfirmClose(false); }
  }, [props.hidden]);
  useEffect(() => () => { clearTimeout(longPress.current); clearTimeout(actionTimer.current); clearTimeout(speechTimer.current); }, []);

  function say(text: string) {
    clearTimeout(speechTimer.current); setSpeech(text);
    speechTimer.current = setTimeout(() => setSpeech(''), 8000);
  }
  function play(next: PetAnimation) {
    clearTimeout(actionTimer.current); setAction(next);
    actionTimer.current = setTimeout(() => setAction('idle'), petAnimations[next].durations.reduce<number>((total, time) => total + time, 0));
  }
  function showControls() { setControls(true); setConfirmClose(false); }
  function updatePosition(next: PetPoint) { positionRef.current = next; setPosition(next); }
  function persistPosition(next: PetPoint) {
    const version = ++saveVersion.current;
    void props.onMove(next).catch(error => {
      if (version === saveVersion.current) updatePosition(props.position || { x: 0, y: 0 });
      props.onError(`保存宠物位置失败：${error instanceof Error ? error.message : error}`);
    });
  }
  function cancelDrag() {
    clearTimeout(longPress.current);
    if (drag.current) updatePosition(drag.current.position);
    drag.current = null; setDragging(null);
  }
  function pointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || !event.isPrimary) return;
    dragged.current = false; consumed.current = false;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, position: positionRef.current };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    clearTimeout(longPress.current);
    if (event.pointerType === 'touch') longPress.current = setTimeout(() => { consumed.current = true; showControls(); }, 500);
  }
  function pointerMove(event: PointerEvent<HTMLButtonElement>) {
    const start = drag.current;
    if (!start || start.id !== event.pointerId || consumed.current || !layout) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    if (!dragged.current && Math.abs(dx) + Math.abs(dy) <= 4) return;
    clearTimeout(longPress.current); dragged.current = true; setControls(false); setSpeech('');
    setDragging(dx < 0 ? 'running-left' : 'running-right');
    updatePosition(clampPetOffset({ x: start.position.x + dx, y: start.position.y + dy }, layout.origin, size, layout.viewport));
  }
  function pointerUp(event: PointerEvent<HTMLButtonElement>) {
    if (drag.current?.id !== event.pointerId) return;
    clearTimeout(longPress.current); drag.current = null; setDragging(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (dragged.current) persistPosition(positionRef.current);
  }
  function commitScale() {
    scaleEditing.current = false;
    const next = scaleRef.current, previous = savedScale.current;
    if (next === previous) return;
    savedScale.current = next;
    void props.onResize(next).catch(error => {
      if (savedScale.current === next) { savedScale.current = previous; scaleRef.current = previous; setScale(previous); }
      props.onError(`保存宠物大小失败：${error instanceof Error ? error.message : error}`);
    });
  }
  function resetPosition() { updatePosition({ x: 0, y: 0 }); persistPosition({ x: 0, y: 0 }); }
  const activity = dragging || (props.activity === 'idle' ? action : props.activity);
  return <>
    <span ref={anchor} className="composer-pet pet-anchor" style={size} aria-hidden="true" />
    {layout && createPortal(<div ref={root} data-popover className={`pet-companion ${dragging ? 'is-dragging' : ''}`} style={{ ...size, left: layout.origin.x + offset.x, top: layout.origin.y + offset.y, visibility: props.hidden ? 'hidden' : undefined }}>
      <button ref={avatar} type="button" className="pet-avatar" aria-label={`宠物：${props.name}`} aria-haspopup="dialog" aria-expanded={controls} aria-controls={controls ? panelId : undefined}
        title="点击互动 · 双击跳跃 · 拖动移动 · 右键或长按设置"
        onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={cancelDrag} onLostPointerCapture={() => { if (drag.current) cancelDrag(); }}
        onClick={() => { if (!dragged.current && !consumed.current) { play('waving'); say(props.latestReply || `你好，我是 ${props.name}。可以拖动我，右键或长按打开设置。`); } }}
        onDoubleClick={() => { if (!dragged.current) play('jumping'); }}
        onContextMenu={event => { event.preventDefault(); clearTimeout(longPress.current); showControls(); }}
        onKeyDown={event => {
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); showControls(); return; }
          if (event.key === 'Home') { event.preventDefault(); resetPosition(); return; }
          const direction: Record<string, PetPoint> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
          const delta = direction[event.key];
          if (delta && layout) {
            event.preventDefault(); const step = event.shiftKey ? 40 : 10;
            const next = clampPetOffset({ x: offset.x + delta.x * step, y: offset.y + delta.y * step }, layout.origin, size, layout.viewport);
            updatePosition(next); persistPosition(next);
          }
        }}>
        <PetSprite src={props.src} name={props.name} scale={scale} activity={activity} />
      </button>
      {controls && <div ref={panel} id={panelId} role={confirmClose ? 'alertdialog' : 'dialog'} aria-label={confirmClose ? '关闭宠物' : '宠物操作'} className="pet-panel" style={{ left: panelPosition.x, top: panelPosition.y }}>
        {confirmClose ? <><strong>关闭宠物？</strong><p>可以在设置 → 通用 → 宠物中重新开启。</p><div className="pet-panel-actions"><button type="button" onClick={() => setConfirmClose(false)}>取消</button><button type="button" className="pet-danger" onClick={() => { setControls(false); props.onClose(); }}>关闭</button></div></> : <>
          <div className="pet-panel-heading"><strong>{props.name}</strong><button type="button" aria-label="收起宠物操作" onClick={() => { setControls(false); avatar.current?.focus(); }}><X size={14} /></button></div>
          <label className="pet-scale-label" htmlFor={`${panelId}-scale`}>宠物大小 <output>{Math.round(scale / 0.55 * 100)}%</output></label>
          <input ref={slider} id={`${panelId}-scale`} type="range" aria-label="宠物大小" min="0.25" max="1.25" step="0.01" value={scale}
            onPointerDown={() => { scaleEditing.current = true; }} onKeyDown={() => { scaleEditing.current = true; }}
            onChange={event => { const next = Number(event.target.value); scaleRef.current = next; setScale(next); }} onPointerUp={commitScale} onKeyUp={commitScale} onBlur={commitScale} onPointerCancel={commitScale} />
          <div className="pet-panel-actions"><button type="button" onClick={resetPosition}><RotateCcw size={13} />重置位置</button><button type="button" onClick={() => setConfirmClose(true)}><X size={13} />关闭宠物</button></div>
          <p>点击互动 · 双击跳跃 · 拖动移动<br />方向键微调 · Home 回到输入框旁</p>
        </>}
      </div>}
      {speech && !controls && !dragging && <div ref={bubble} role="status" aria-label="宠物气泡" className="pet-reply-bubble" style={{ left: bubblePosition.x, top: bubblePosition.y }}><button type="button" aria-label="关闭宠物气泡" onClick={() => setSpeech('')}><X size={12} /></button><span>{speech}</span></div>}
    </div>, document.body)}
  </>;
}
