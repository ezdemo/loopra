import { createContext, useContext, useEffect, useState } from 'react';
import { useImagePreview } from './ImagePreview';

const ToolImageSourceContext = createContext<((path: string) => string) | null>(null);
export const ToolImageSourceProvider = ToolImageSourceContext.Provider;

function ImageThumbnail({ source, index }: { source: string; index: number }) {
  const preview = useImagePreview();
  const resolve = useContext(ToolImageSourceContext);
  const direct = /^(?:data:image\/|https?:\/\/)/i.test(source);
  const [loaded, setLoaded] = useState<{ source: string; url?: string; error?: boolean }>();
  useEffect(() => {
    if (direct || !resolve) return;
    const controller = new AbortController();
    let objectUrl = '';
    void fetch(resolve(source), { signal: controller.signal }).then(async response => {
      if (!response.ok || !/^image\/(png|jpeg|gif|webp)/i.test(response.headers.get('Content-Type') || '')) throw new Error('图片不可读取');
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setLoaded({ source, url: objectUrl });
    }).catch(() => { if (!controller.signal.aborted) setLoaded({ source, error: true }); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [source, direct, resolve]);
  const state = loaded?.source === source ? loaded : undefined;
  const src = direct ? source : state?.url;
  const failed = state?.error || (!direct && !resolve);
  return <button type="button" className="tool-image-thumbnail" aria-label={`放大图像 ${index + 1}`} title={source.startsWith('data:') ? '点击放大' : source}
    disabled={!src || !preview || failed} onClick={() => { if (src) preview?.(src); }}>
    {failed ? <span className="tool-image-unavailable">图片预览不可用</span>
      : src ? <img src={src} alt={`已查看的图像 ${index + 1}`} loading="lazy" onError={() => setLoaded({ source, error: true })} />
      : <span className="tool-image-unavailable" role="status">正在读取图片…</span>}
  </button>;
}

export default function ToolImageResult({ images }: { images: string[] }) {
  return <section className="tool-image-result" aria-label={`已查看 ${images.length} 张图像`}>
    <div className="tool-image-thumbnails">{images.map((source, index) => <ImageThumbnail key={source} source={source} index={index} />)}</div>
  </section>;
}
