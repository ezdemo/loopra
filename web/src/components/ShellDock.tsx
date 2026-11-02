import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ChevronDown, Plus, SquareTerminal, X } from 'lucide-react';
import type { LoopraClient } from '../backend';
import { useShellTerminal, type ShellSession } from '../shell-terminal';
import { usePresence } from './Motion';

type Props = {
  api: LoopraClient; workspaceHash: string; open: boolean; onClose: () => void;
};

export default function ShellDock({ api, workspaceHash, open, onClose }: Props) {
  const [sessions, setSessions] = useState<ShellSession[]>([]);
  const [active, setActive] = useState('');
  const [error, setError] = useState('');
  const [height, setHeight] = useState(280);
  const creating = useRef(false);
  const mounted = usePresence(open);
  const host = useShellTerminal(api.base, workspaceHash, active, mounted);

  async function create() {
    if (creating.current) return;
    creating.current = true;
    setError('');
    try {
      const created = await api.request<ShellSession>('/shell-terminal/sessions', 'POST', { workspaceHash });
      setSessions(current => current.some(item => item.id === created.id) ? current : [...current, created]);
      setActive(created.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '打开终端失败');
    } finally { creating.current = false; }
  }

  useEffect(() => {
    if (!open || !workspaceHash) return;
    let cancelled = false;
    const controller = new AbortController();
    void api.request<{ sessions: ShellSession[] }>(`/shell-terminal/sessions?workspaceHash=${encodeURIComponent(workspaceHash)}`, 'GET', undefined, controller.signal)
      .then(data => {
        if (cancelled) return;
        const list = data.sessions || [];
        setSessions(list);
        if (list.length) setActive(current => current && list.some(item => item.id === current) ? current : list[0].id);
        else void create();
      })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '读取终端失败'); });
    return () => { cancelled = true; controller.abort(); };
  }, [api, workspaceHash, open]);

  async function closeSession(id: string) {
    const remaining = sessions.filter(item => item.id !== id);
    setSessions(remaining);
    setActive(current => current === id ? remaining[0]?.id || '' : current);
    if (!remaining.length) onClose();
    try { await api.request(`/shell-terminal/sessions/${encodeURIComponent(id)}?workspaceHash=${encodeURIComponent(workspaceHash)}`, 'DELETE'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '关闭终端失败'); }
  }

  if (!mounted) return null;
  const tabLabel = (index: number) => `终端 ${index + 1}`;
  return <section className="shell-dock" data-open={open} aria-hidden={!open}
    {...(!open ? { inert: '' } : {})}
    style={{ height, '--shell-dock-height': `${height}px` } as CSSProperties} aria-label="终端">
    <div className="shell-dock-resize" role="separator" aria-orientation="horizontal" aria-label="调整终端高度"
      onPointerDown={event => {
        const startY = event.clientY;
        const start = height;
        const move = (next: PointerEvent) => setHeight(Math.min(Math.max(160, start + startY - next.clientY), Math.round(window.innerHeight * 0.7)));
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
      }} />
    <header>
      <span><SquareTerminal size="1rem" />终端</span>
      <div className="shell-dock-tabs" role="tablist" aria-label="终端会话">
        {sessions.map((item, index) => <div key={item.id} className={item.id === active ? 'active' : ''}>
          <button type="button" role="tab" aria-selected={item.id === active} title={item.title || item.cwd} onClick={() => setActive(item.id)}>{tabLabel(index)}</button>
          <button type="button" className="shell-dock-tab-close" aria-label={`关闭${tabLabel(index)}`} title={`关闭${tabLabel(index)}`} onClick={() => void closeSession(item.id)}><X size={12} /></button>
        </div>)}
      </div>
      <div className="shell-dock-actions">
        <button type="button" aria-label="新建终端" title="新建终端" onClick={() => void create()}><Plus size={16} /></button>
        <button type="button" aria-label="隐藏终端" title="隐藏终端" onClick={onClose}><ChevronDown size={17} /></button>
      </div>
    </header>
    {error && <p className="settings-error" role="alert">{error}</p>}
    <div className="shell-dock-screen" ref={host} hidden={!active} />
  </section>;
}
