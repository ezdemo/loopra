import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Popup } from '../components/Motion';
import AgentIcon, { PersonaIcon } from '../components/AgentIcon';
import type { AgentEngine, CustomAgent } from '../backend';
import { useMenuPlacement } from './menu-placement';

/**
 * Agent chooser shown beside the project switcher on the home screen. Switching
 * starts a new conversation, so it stays disabled while any run is active.
 * Only installed external engines show up here: detection status, install help
 * and per-engine visibility live in 设置 → 外部 Agent. The current selection is
 * always listed so its check stays visible even when it was hidden afterwards.
 * Custom agents are personas on the native engine: picking one also selects
 * Loopra Native, so external engines never receive them.
 */
export default function AgentSwitcher({ engines, agentId, disabled, disabledReason, onSelect, onRefreshEngines, agents, customAgentId, onSelectAgent }: {
  engines: AgentEngine[]; agentId: string; disabled: boolean; disabledReason?: string; onSelect: (id: string) => void;
  /** Re-detect the runtime when the menu opens (the backend checks on every call). */
  onRefreshEngines?: () => void;
  /** Custom agent personas for the new session (empty hides the section). */
  agents?: CustomAgent[];
  customAgentId?: string;
  onSelectAgent?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  // Same placement rules as the project menu: upward by default, capped to the
  // room its clipping pane leaves, and flipped below only when that is unusable.
  const placement = useMenuPlacement(open, root);
  const placementStyle = (placement.maxHeight ? { '--menu-max-height': `${placement.maxHeight}px` } : undefined) as CSSProperties | undefined;
  useEffect(() => {
    if (!open) return undefined;
    const pointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', escape); };
  }, [open]);
  const current = engines.find(engine => engine.id === (agentId || 'native'));
  const persona = agents?.find(item => item.id === customAgentId);
  const listed = engines.filter(engine => engine.id === 'native' || engine.id === (agentId || 'native') || (engine.available && !engine.hidden));
  function toggle() {
    if (open) { setOpen(false); return; }
    // Installation happens outside the app, so re-detect every time the menu opens.
    onRefreshEngines?.();
    setOpen(true);
  }
  return <div className="agent-selector menu-anchor" data-popover ref={root} data-placement={placement.side} style={placementStyle}>
    <button type="button" aria-label="选择 Agent" aria-expanded={open} disabled={disabled}
      title={disabled ? disabledReason || '任务运行中，结束后才能切换 Agent' : '选择 Agent'} onClick={toggle}>
      {persona ? <PersonaIcon icon={persona.icon} /> : <AgentIcon agentId={agentId || 'native'} />}
      {persona?.name || current?.name || (agentId === 'native' ? 'Loopra Native' : agentId)}
      <ChevronDown size="0.875rem" />
    </button>
    <Popup open={open} className="popup workspace-menu agent-menu">
      <h3>选择 Agent</h3>
      <div className="composer-tool-list">{listed.map(engine => {
        const selected = !persona && engine.id === (agentId || 'native');
        return <div key={engine.id} className="agent-option">
          <button type="button" disabled={!engine.available}
            title={!engine.available ? engine.detail || '依赖未就绪' : undefined}
            onClick={() => { setOpen(false); onSelect(engine.id); }}>
            <AgentIcon agentId={engine.id} />
            <span><strong>{engine.name}</strong></span>
            {selected && <Check size="1rem" />}
          </button>
        </div>;
      })}</div>
      {!!agents?.length && onSelectAgent && <>
        <h3>自定义智能体</h3>
        <div className="composer-tool-list">{agents.map(agent => {
          const selected = agent.id === customAgentId;
          return <div key={agent.id} className="agent-option">
            <button type="button" title={agent.instruction || undefined} onClick={() => { setOpen(false); onSelectAgent(selected ? '' : agent.id); }}>
              <PersonaIcon icon={agent.icon} />
              <span><strong>{agent.name}</strong></span>
              {selected && <Check size="1rem" />}
            </button>
          </div>;
        })}</div>
      </>}
    </Popup>
  </div>;
}
