import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

const ImagePreviewContext = createContext<((url: string) => void) | null>(null);

// Returns null when no provider is mounted so callers can keep their default
// rendering (e.g. markdown images rendered outside the chat surface).
export function useImagePreview() {
  return useContext(ImagePreviewContext);
}

// Ported from Chat.vue's `image-preview-overlay` (Teleport to body, click the
// backdrop or press Escape to close).
export function ImagePreviewProvider({ children }: { children: ReactNode }) {
  const [url, setUrl] = useState('');
  const close = useCallback(() => setUrl(''), []);
  const preview = useCallback((next: string) => { if (next) setUrl(next); }, []);
  useEffect(() => {
    if (!url) return;
    const onKeydown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  }, [url, close]);
  return <ImagePreviewContext.Provider value={preview}>
    {children}
    {url && createPortal(<div className="image-preview-overlay" role="dialog" aria-modal="true" aria-label="图片预览" onClick={event => { if (event.target === event.currentTarget) close(); }}>
      <img className="image-preview-full" src={url} alt="图片预览" />
      <button type="button" className="image-preview-close" aria-label="关闭图片预览" title="关闭" onClick={close}><X size="1.125rem" /></button>
    </div>, document.body)}
  </ImagePreviewContext.Provider>;
}
