import { useEffect, useRef, useState } from 'react';
import { petAnimations, petFrame, petIdleActions, petSpriteSize, type PetAnimation } from '../pets';
import { useAppMotion } from './Motion';

// Match legacy PetSprite.vue, using the actual aspect ratio for 8×9/8×11 atlases.
export default function PetSprite({ src, name, scale = 0.55, activity = 'idle', className = '', lazy = false }: {
  src: string; name: string; scale?: number; activity?: PetAnimation; className?: string; lazy?: boolean;
}) {
  const { enabled } = useAppMotion();
  const host = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(!lazy);
  const [requested, setRequested] = useState(!lazy);
  const [image, setImage] = useState({ src: '', ratio: 0, failed: false });
  const [frame, setFrame] = useState(0);
  const [action, setAction] = useState<PetAnimation>('idle');
  const [visible, setVisible] = useState(() => !document.hidden);
  const loaded = image.src === src && image.ratio > 0;
  const failed = image.src === src && image.failed;
  const animation = activity === 'idle' ? action : activity;
  useEffect(() => {
    if (!lazy || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      setRequested(true);
      return;
    }
    // Settings can contain many large atlases below the fold. Load and animate
    // only previews near the visible part of the scroll container.
    const observer = new IntersectionObserver(([entry]) => {
      setInView(entry.isIntersecting);
      if (entry.isIntersecting) setRequested(true);
    }, { rootMargin: '80px' });
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, [lazy]);
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  useEffect(() => {
    setAction('idle');
    if (!enabled || !visible || !inView || !loaded || activity !== 'idle') return;
    let timer: ReturnType<typeof setTimeout>;
    function schedule() {
      timer = setTimeout(() => {
        const next = petIdleActions[Math.floor(Math.random() * petIdleActions.length)];
        setAction(next);
        timer = setTimeout(() => { setAction('idle'); schedule(); }, petAnimations[next].durations.reduce<number>((sum, duration) => sum + duration, 0));
      }, 4000 + Math.random() * 8000);
    }
    schedule();
    return () => clearTimeout(timer);
  }, [activity, enabled, visible, inView, loaded, src]);
  useEffect(() => {
    setFrame(0);
    if (!enabled || !visible || !inView || !loaded) return;
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout>;
    function tick() {
      const current = petFrame(animation, performance.now() - started);
      setFrame(current);
      timer = setTimeout(tick, petAnimations[animation].durations[current]);
    }
    tick();
    return () => clearTimeout(timer);
  }, [animation, enabled, visible, inView, loaded, src]);
  const { width, height } = petSpriteSize(scale);
  return <div ref={host} className={`pet-sprite ${className} ${loaded ? 'is-loaded' : ''}`} role="img" aria-label={`宠物：${name}`} title={failed ? '宠物图片加载失败，请在设置中重新加载' : name}
    style={{ width, height }} data-pet-animation={animation}>
    {requested && <img key={src} src={src} alt="" draggable={false} decoding="async" onLoad={event => {
      const image = event.currentTarget;
      setImage({ src, ratio: image.naturalHeight / image.naturalWidth, failed: false });
    }} onError={() => setImage({ src, ratio: 0, failed: true })}
      style={{ width: width * 8, height: width * 8 * image.ratio, transform: `translate(${-frame * width}px, ${-petAnimations[animation].row * height}px)` }} />}
    {failed && <span className="pet-image-error">图片加载失败</span>}
  </div>;
}
