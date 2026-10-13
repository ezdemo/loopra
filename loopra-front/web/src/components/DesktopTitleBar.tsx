import { useEffect, useState } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';
import { desktopPlatform, desktopWindowApi, windowControlsOnLeft } from '../desktop-shell';

// Frameless-window title bar for the Electron renderer. Renders nothing in the
// browser (no `electronAPI.window`), so the web layout is unchanged.
export default function DesktopTitleBar() {
  const api = desktopWindowApi();
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.resolve(api?.isMaximized?.()).then(value => { if (active) setMaximized(!!value); }).catch(() => {});
    return () => { active = false; };
  }, [api]);
  if (!api) return null;
  const controls = <div className="desktop-window-controls">
    <button type="button" className="dw-btn" aria-label="最小化窗口" title="最小化" onClick={() => void Promise.resolve(api.minimize?.())}><Minus size={14} /></button>
    <button type="button" className="dw-btn" aria-label={maximized ? '还原窗口' : '最大化窗口'} title={maximized ? '还原' : '最大化'} onClick={() => { setMaximized(value => !value); void Promise.resolve(api.maximize?.()); }}>{maximized ? <Copy size={13} /> : <Square size={12} />}</button>
    <button type="button" className="dw-btn dw-close" aria-label="关闭窗口" title="关闭" onClick={() => void Promise.resolve(api.close?.())}><X size={14} /></button>
  </div>;
  const left = windowControlsOnLeft(desktopPlatform());
  return <header className="desktop-titlebar" aria-label="窗口标题栏">
    {left && controls}
    <span className="desktop-titlebar-title">Loopra</span>
    <span className="desktop-titlebar-spacer" />
    {!left && controls}
  </header>;
}
