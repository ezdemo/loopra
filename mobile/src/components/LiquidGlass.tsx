import { useEffect, useId, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { rasterizeLens } from '../glass-optics';

type Maps = { width: number; height: number; scale: number; displacement: string; highlight: string };
const cache = new Map<string, Maps>();
function lensMaps(width: number, height: number): Maps | undefined {
  const key = `${width}:${height}`;
  if (cache.has(key)) return cache.get(key);
  const map = rasterizeLens(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return;
  const encode = (pixels: Uint8ClampedArray) => {
    const image = context.createImageData(width, height); image.data.set(pixels);
    context.putImageData(image, 0, 0); return canvas.toDataURL('image/png');
  };
  const maps = { width, height, scale: map.scale, displacement: encode(map.displacement), highlight: encode(map.highlight) };
  const oldest = cache.keys().next().value;
  if (cache.size >= 12 && oldest) cache.delete(oldest);
  cache.set(key, maps); return maps;
}

/** Filter the real backdrop only. Labels and hit targets stay outside the optics. */
export default function LiquidGlass({ target }: { target: RefObject<HTMLElement> }) {
  const id = `phone-lens-${useId().replace(/:/g, '')}`;
  const [maps, setMaps] = useState<Maps>();
  useEffect(() => {
    const node = target.current;
    if (!node) return;
    const transparency = matchMedia('(prefers-reduced-transparency: reduce)');
    const chromium = /Chrome\//.test(navigator.userAgent) && !/Firefox\//.test(navigator.userAgent);
    const update = () => {
      if (!chromium || transparency.matches || !CSS.supports('backdrop-filter', 'url("#lens")')) { setMaps(undefined); return; }
      const width = Math.round(node.clientWidth); const height = Math.round(node.clientHeight);
      if (width < 2 || height < 2 || width > 1024 || height > 1024) return;
      setMaps(lensMaps(width, height));
    };
    const resize = new ResizeObserver(update); resize.observe(node); update();
    transparency.addEventListener('change', update);
    return () => { resize.disconnect(); transparency.removeEventListener('change', update); };
  }, [target]);
  return <>
    {maps && <svg className="phone-optics-defs" width="0" height="0" aria-hidden="true" focusable="false"><defs><filter id={id} x="0" y="0" width={maps.width} height={maps.height} filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
      <feGaussianBlur in="SourceGraphic" stdDeviation="0.35" result="frost" />
      <feImage href={maps.displacement} x="0" y="0" width={maps.width} height={maps.height} preserveAspectRatio="none" result="map" />
      <feComponentTransfer in="map" result="field"><feFuncR type="linear" slope={255 / 256} /><feFuncG type="linear" slope={255 / 256} /></feComponentTransfer>
      <feDisplacementMap in="frost" in2="field" scale={maps.scale * 1.018} xChannelSelector="R" yChannelSelector="G" result="red" />
      <feColorMatrix in="red" type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="r" />
      <feDisplacementMap in="frost" in2="field" scale={maps.scale} xChannelSelector="R" yChannelSelector="G" result="green" />
      <feColorMatrix in="green" type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="g" />
      <feDisplacementMap in="frost" in2="field" scale={maps.scale * .982} xChannelSelector="R" yChannelSelector="G" result="blue" />
      <feColorMatrix in="blue" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="b" />
      <feBlend in="r" in2="g" mode="screen" result="rg" /><feBlend in="rg" in2="b" mode="screen" result="refracted" />
      <feColorMatrix in="refracted" type="saturate" values="1.2" result="glass" />
      <feImage href={maps.highlight} x="0" y="0" width={maps.width} height={maps.height} preserveAspectRatio="none" result="rim" />
      <feBlend in="glass" in2="rim" mode="screen" />
    </filter></defs></svg>}
    <span aria-hidden="true" className={`phone-liquid-backdrop ${maps ? 'is-refractive' : ''}`} style={maps ? { '--phone-lens-filter': `url("#${id}")` } as CSSProperties : undefined} />
    <span aria-hidden="true" className="phone-liquid-rim" />
  </>;
}
