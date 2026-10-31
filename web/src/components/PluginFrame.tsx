import { useEffect, useRef, useState } from 'react';
import type { LoopraClient } from '../backend';
import { errorText } from './RemoteControls';

export type PluginContext = { workspaceHash?: string; workspaceDir?: string; sessionId?: string; filePath?: string };

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

export function PluginFrame({ api, id, name, slot, className, title, menuItem = '', context }: {
  api: LoopraClient;
  id: string;
  name: string;
  slot: 'ui' | 'sidebar' | 'menu';
  className?: string;
  title?: string;
  menuItem?: string;
  context?: PluginContext;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const contextRef = useRef(context);
  contextRef.current = context;
  const announceRef = useRef<() => void>(() => {});
  const [src, setSrc] = useState('');
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => { announceRef.current(); }, [context]);
  useEffect(() => {
    const currentId = id;
    const currentName = name;
    let gone = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    setSrc('');
    setError('');
    const frame = () => frameRef.current;
    const send = (data: Record<string, unknown>) => { if (!gone) frame()?.contentWindow?.postMessage(data, '*'); };
    const node = document.querySelector('.workspace-theme') ?? document.documentElement;
    const ready = () => send({ type: 'loopra', op: 'ready', plugin: { id: currentId, name: currentName }, theme: pluginTheme(), context: contextRef.current || {} });
    announceRef.current = ready;
    const fail = (message: string) => { if (!gone) { clearTimeout(timer); controller.abort(); setError(message); } };
    const observer = node ? new MutationObserver(ready) : undefined;
    if (node && observer) observer.observe(node, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    async function onMessage(event: MessageEvent) {
      if (!frame() || event.source !== frame()?.contentWindow) return;
      const data = event.data as { type?: string; op?: string; id?: unknown; action?: string; value?: unknown; message?: string } | null;
      if (!data || data.type !== 'loopra') return;
      if (data.op === 'hello') { clearTimeout(timer); ready(); return; }
      if (data.op === 'error') { fail(typeof data.message === 'string' ? data.message.slice(0, 2000) : '页面运行出错'); return; }
      if (data.op === 'service:request') {
        try { send({ type: 'loopra', op: 'service:result', id: data.id, value: await api.request(`/plugins/${encodeURIComponent(currentId)}/request`, 'POST', { action: data.action, value: pluginConfigValue(data.value) || {}, context: contextRef.current || {} }, controller.signal) }); }
        catch (cause) { send({ type: 'loopra', op: 'service:result', id: data.id, error: errorText(cause) }); }
      }
      if (data.op === 'config:get') {
        try { send({ type: 'loopra', op: 'config', id: data.id, value: await api.request(`/plugins/${encodeURIComponent(currentId)}/config`, 'GET', undefined, controller.signal) }); }
        catch (cause) { send({ type: 'loopra', op: 'config', id: data.id, error: errorText(cause) }); }
      }
      if (data.op === 'config:set') {
        const value = pluginConfigValue(data.value);
        if (!value || JSON.stringify(value).length > 65536) { send({ type: 'loopra', op: 'config', id: data.id, error: '插件配置必须是对象' }); return; }
        try { send({ type: 'loopra', op: 'config', id: data.id, value: await api.request(`/plugins/${encodeURIComponent(currentId)}/config`, 'POST', value, controller.signal) }); }
        catch (cause) { send({ type: 'loopra', op: 'config', id: data.id, error: errorText(cause) }); }
      }
    }
    window.addEventListener('message', onMessage);
    const page = slot === 'sidebar' ? api.pluginSidebar(currentId) : slot === 'menu' ? api.pluginMenu(currentId, menuItem) : api.pluginPage(currentId);
    void api.request<{ page?: string }>(`/plugins/${encodeURIComponent(currentId)}/${slot}/open`, 'POST', {}, controller.signal)
      .then(opened => {
        if (gone) return;
        timer = setTimeout(() => fail('插件页面未响应'), 10000);
        if (opened?.page) {
          const child = slot === 'menu' && menuItem ? `${encodeURIComponent(menuItem)}/` : '';
          setSrc(api.assetUrl(`${opened.page}${child}`));
          return;
        }
        setSrc(page);
      })
      .catch(cause => fail(errorText(cause)));
    return () => { gone = true; controller.abort(); clearTimeout(timer); observer?.disconnect(); window.removeEventListener('message', onMessage); announceRef.current = () => {}; };
  }, [api, id, name, slot, menuItem, revision]);
  return <>
    {error && <div role="alert" className="panel-empty"><p className="settings-error">{error}</p><button type="button" onClick={() => setRevision(value => value + 1)}>重试</button></div>}
    {!error && !src && <p className="panel-empty" role="status">正在打开…</p>}
    {src && !error && <iframe ref={frameRef} className={className || 'plugin-settings-frame'} title={title || name} sandbox="allow-scripts" referrerPolicy="no-referrer" src={src} onLoad={() => announceRef.current()} />}
  </>;
}
