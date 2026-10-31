import { useEffect, useRef, useState } from 'react';
import type { LoopraClient } from '../backend';
import { errorText } from './RemoteControls';

const pluginThemeKeys = ['surface', 'sidebar', 'soft', 'hover', 'line', 'line-strong', 'text', 'secondary', 'muted', 'blue', 'accent', 'accent-soft', 'success', 'warning', 'danger', 'radius-sm', 'radius-md', 'radius-lg', 'radius-xl', 'shadow-sm', 'shadow', 'shadow-pop'] as const;

function pluginTheme() {
  const node = document.querySelector('.workspace-theme') ?? document.documentElement;
  const style = getComputedStyle(node);
  const dark = node.classList.contains('dark') || node.getAttribute('data-theme') === 'dark' || document.documentElement.classList.contains('dark');
  return {
    ...Object.fromEntries(pluginThemeKeys.map(key => [key, style.getPropertyValue(`--${key}`).trim()])),
    font: style.getPropertyValue('--workspace-font').trim(),
    code: '"JetBrains Mono Variable", Consolas, "Cascadia Code", monospace',
    dark: dark ? 'dark' : '',
  };
}

function pluginConfigValue(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function PluginFrame({ api, id, name, slot, className, title, menuItem = '' }: {
  api: LoopraClient;
  id: string;
  name: string;
  slot: 'ui' | 'sidebar' | 'menu';
  className?: string;
  title?: string;
  menuItem?: string;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [src, setSrc] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const currentId = id;
    const currentName = name;
    let gone = false;
    setSrc('');
    setError('');
    const frame = () => frameRef.current;
    const send = (data: Record<string, unknown>) => frame()?.contentWindow?.postMessage(data, '*');
    const node = document.querySelector('.workspace-theme');
    const ready = () => send({ type: 'loopra', op: 'ready', plugin: { id: currentId, name: currentName }, theme: pluginTheme() });
    const observer = node ? new MutationObserver(ready) : undefined;
    if (node && observer) observer.observe(node, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    async function onMessage(event: MessageEvent) {
      if (!frame() || event.source !== frame()?.contentWindow) return;
      const data = event.data as { type?: string; op?: string; id?: unknown; action?: string; value?: unknown } | null;
      if (!data || data.type !== 'loopra') return;
      if (data.op === 'service:request') {
        try { send({ type: 'loopra', op: 'service:result', id: data.id, value: await api.request(`/plugins/${encodeURIComponent(currentId)}/request`, 'POST', { action: data.action, value: pluginConfigValue(data.value) || {} }) }); }
        catch (cause) { send({ type: 'loopra', op: 'service:result', id: data.id, error: errorText(cause) }); }
      }
      if (data.op === 'config:get') {
        try { send({ type: 'loopra', op: 'config', id: data.id, value: await api.request(`/plugins/${encodeURIComponent(currentId)}/config`) }); }
        catch (cause) { send({ type: 'loopra', op: 'config', id: data.id, error: errorText(cause) }); }
      }
      if (data.op === 'config:set') {
        const value = pluginConfigValue(data.value);
        if (!value || JSON.stringify(value).length > 65536) { send({ type: 'loopra', op: 'config', id: data.id, error: '插件配置必须是对象' }); return; }
        try { send({ type: 'loopra', op: 'config', id: data.id, value: await api.request(`/plugins/${encodeURIComponent(currentId)}/config`, 'POST', value) }); }
        catch (cause) { send({ type: 'loopra', op: 'config', id: data.id, error: errorText(cause) }); }
      }
    }
    window.addEventListener('message', onMessage);
    const page = slot === 'sidebar' ? api.pluginSidebar(currentId) : slot === 'menu' ? api.pluginMenu(currentId, menuItem) : api.pluginPage(currentId);
    void api.request<{ page?: string }>(`/plugins/${encodeURIComponent(currentId)}/${slot}/open`, 'POST', {})
      .then(opened => {
        if (gone) return;
        if (opened?.page) {
          const child = slot === 'menu' && menuItem ? `${encodeURIComponent(menuItem)}/` : '';
          setSrc(api.assetUrl(`${opened.page}${child}`));
          return;
        }
        setSrc(page);
      })
      .catch(cause => { if (!gone) setError(errorText(cause)); });
    return () => { gone = true; observer?.disconnect(); window.removeEventListener('message', onMessage); };
  }, [api, id, name, slot, menuItem]);
  return <>
    {error && <p role="alert" className="settings-error">{error}</p>}
    {!error && !src && <p className="panel-empty" role="status">正在打开…</p>}
    {src && <iframe ref={frameRef} className={className || 'plugin-settings-frame'} title={title || name} sandbox="allow-scripts" referrerPolicy="no-referrer" src={src} onLoad={() => frameRef.current?.contentWindow?.postMessage({ type: 'loopra', op: 'ready', plugin: { id, name }, theme: pluginTheme() }, '*')} />}
  </>;
}
