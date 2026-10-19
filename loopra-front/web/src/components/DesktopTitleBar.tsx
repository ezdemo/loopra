import { useEffect, useState } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';
import { desktopPlatform, desktopWindowApi, usesNativeWindowControls } from '../desktop-shell';

// Title bar for the Electron renderer. Renders nothing in the browser (no
// `electronAPI.window`), so the web layout is unchanged. The controls float over
// the sidebar brand / conversation header row, which itself is the drag region;
// on macOS the native traffic lights replace the drawn controls.
export default function DesktopTitleBar() {
  const api = desktopWindowApi();
  const nativeControls = usesNativeWindowControls(desktopPlatform());
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!api || nativeControls) return;
    let active = true;
    void Promise.resolve(api.isMaximized?.()).then(value => { if (active) setMaximized(!!value); }).catch(() => {});
    return () => { active = false; };
  }, [api, nativeControls]);
  if (!api) return null;
  return <header className={`desktop-titlebar${nativeControls ? ' is-native-controls' : ''}`} aria-label="窗口标题栏">
    {!nativeControls && <div className="desktop-window-controls">
      <button type="button" className="dw-btn" aria-label="最小化窗口" title="最小化" onClick={() => void Promise.resolve(api.minimize?.())}><Minus size={14} /></button>
      <button type="button" className="dw-btn" aria-label={maximized ? '还原窗口' : '最大化窗口'} title={maximized ? '还原' : '最大化'} onClick={() => { setMaximized(value => !value); void Promise.resolve(api.maximize?.()); }}>{maximized ? <Copy size={13} /> : <Square size={12} />}</button>
      <button type="button" className="dw-btn dw-close" aria-label="关闭窗口" title="关闭" onClick={() => void Promise.resolve(api.close?.())}><X size={14} /></button>
    </div>}
  </header>;
}
