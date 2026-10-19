import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Popup } from '../components/Motion';
import type { AgentEngine } from '../backend';

/**
 * Agent chooser shown beside the project switcher on the home screen. Switching
 * starts a new conversation, so it stays disabled while any run is active.
 */
export default function AgentSwitcher({ engines, agentId, disabled, onSelect }: {
  engines: AgentEngine[]; agentId: string; disabled: boolean; onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const pointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', escape); };
  }, [open]);
  const current = engines.find(engine => engine.id === (agentId || 'native'));
  return <div className="agent-selector menu-anchor" data-popover ref={root}>
    <button type="button" aria-label="选择 Agent" aria-expanded={open} disabled={disabled}
      title={disabled ? '任务运行中，结束后才能切换 Agent' : '选择 Agent'} onClick={() => setOpen(value => !value)}>
      <span className={`agent-dot ${agentId !== 'native' ? 'external' : ''}`} />
      {current?.name || (agentId === 'native' ? 'Loopra Native' : agentId)}
      <ChevronDown size="0.875rem" />
    </button>
    <Popup open={open} className="popup workspace-menu agent-menu">
      <h3>选择 Agent</h3>
      <div className="composer-tool-list">{engines.map(engine => <button key={engine.id} type="button" disabled={!engine.available}
        onClick={() => { setOpen(false); onSelect(engine.id); }}>
        <span><strong>{engine.name}</strong><small>{engine.detail || (engine.available ? (engine.id === 'native' ? '使用 Loopra 模型配置' : '使用本机 Claude 登录和配置') : '后端未检测到运行环境，请重启后端后重试')}</small></span>
        {engine.id === (agentId || 'native') && <Check size="1rem" />}
      </button>)}</div>
      <p className="composer-note">切换 Agent 会新建会话。</p>
    </Popup>
  </div>;
}
