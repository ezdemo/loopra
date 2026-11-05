import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { LoopraClient } from '../backend';
import { isDirectImage, localImagePath } from '../markdown-images';
import { useImagePreview } from './ImagePreview';

const ImageSourceContext = createContext<((path: string) => string) | null>(null);
export const ImageSourceProvider = ImageSourceContext.Provider;

export function SessionImageSourceProvider({ api, workspaceHash, sessionName = '', children }: {
  api: LoopraClient; workspaceHash: string; sessionName?: string; children: ReactNode;
}) {
  const resolve = useCallback((path: string) => api.assetUrl(`/files/image?${new URLSearchParams({ path, workspaceHash, sessionName })}`), [api, workspaceHash, sessionName]);
  return <ImageSourceProvider value={resolve}>{children}</ImageSourceProvider>;
}

export default function ChatImage({ source = '', alt = '', title, className = 'markdown-image-button' }: {
  source?: string; alt?: string; title?: string; className?: string;
}) {
  const preview = useImagePreview();
  const resolve = useContext(ImageSourceContext);
  const direct = isDirectImage(source);
  const path = direct ? null : localImagePath(source);
  const request = direct ? source : path !== null && resolve ? resolve(path) : '';
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ request: string; attempt: number; url?: string; error?: boolean }>();
  useEffect(() => {
    if (direct || !request) return;
    const controller = new AbortController();
    let objectUrl = '';
    void fetch(request, { signal: controller.signal }).then(async response => {
      if (!response.ok || !/^image\/(?:png|jpeg|gif|webp|bmp|x-ms-bmp|avif)(?:;|$)/i.test(response.headers.get('Content-Type') || '')) throw new Error('图片不可读取');
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setLoaded({ request, attempt, url: objectUrl });
    }).catch(() => { if (!controller.signal.aborted) setLoaded({ request, attempt, error: true }); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [request, direct, attempt]);
  const state = loaded?.request === request && loaded.attempt === attempt ? loaded : undefined;
  const failed = !request || state?.error;
  const src = failed ? '' : direct ? request : state?.url;
  if (!src) return <span className="chat-image-state" role="status">{failed ? '图片无法读取' : '正在读取图片…'}{failed && request && <button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button>}</span>;
  const image = <img key={`${request}:${attempt}`} src={src} alt={alt} title={title} loading="lazy" referrerPolicy="no-referrer" onError={() => setLoaded({ request, attempt, error: true })} />;
  if (!preview) return image;
  return <button type="button" className={className} aria-label={alt ? `放大图片：${alt}` : '放大图片'} title={title || '放大图片'} onClick={() => preview(src)}>{image}</button>;
}
