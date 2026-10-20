import { useRef, type CSSProperties, type ReactNode } from 'react';
import { Check, ChevronDown, FolderClosed, FolderPlus } from 'lucide-react';
import { Enter, Popup } from '../components/Motion';
import { LoopraMark } from '../components/ui';
import type { AgentEngine, Workspace } from '../backend';
import AgentSwitcher from './AgentSwitcher';
import { useMenuPlacement } from './menu-placement';

type HomeViewProps = {
  workspaces: Workspace[];
  workspace: string;
  workspaceName: string;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onSelect: (hash: string) => void;
  onManage: () => void;
  engines: AgentEngine[];
  agentId: string;
  agentDisabled: boolean;
  onAgent: (id: string) => void;
  /** Re-detect Agent runtimes when the chooser opens. */
  onRefreshEngines?: () => void;
  /** Isolation switch for the prepared draft, right-aligned on the switcher row. */
  isolation?: ReactNode;
  children: ReactNode;
};

export default function HomeView({ workspaces, workspace, workspaceName, menuOpen, onToggleMenu, onSelect, onManage,
  engines, agentId, agentDisabled, onAgent, onRefreshEngines, isolation, children }: HomeViewProps) {
  // The menu opens upward by default. It is capped to the room above (the list
  // scrolls inside) and only flips below the anchor when the top of the window
  // leaves too little usable height. Heading and footer stay put either way.
  const anchorRef = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(menuOpen, anchorRef);
  const placementStyle = (placement.maxHeight ? { '--menu-max-height': `${placement.maxHeight}px` } : undefined) as CSSProperties | undefined;
  return <section className="welcome-shell">
    <Enter as="div" className="welcome-intro"><h1 className="welcome-logo" aria-label="Loopra"><LoopraMark />Loopra</h1></Enter>
    <div className="welcome-switchers">
      <div ref={anchorRef} className="workspace-selector menu-anchor" data-popover data-placement={placement.side} style={placementStyle}>
        <button onClick={onToggleMenu}><FolderClosed size="1rem" />{workspaceName}<ChevronDown size="0.875rem" /></button>
        <Popup open={menuOpen} className="popup workspace-menu">
          <h3>选择工作区</h3>
          <div className="workspace-menu-list">
            {workspaces.map(item => <button key={item.hash} onClick={() => onSelect(item.hash)}><FolderClosed size="1rem" />{item.name}{workspace === item.hash && <Check size="1rem" />}</button>)}
            {!workspaces.length && <p className="composer-empty">暂无可用项目</p>}
          </div>
          <hr />
          <button onClick={onManage}><FolderPlus size="1rem" />管理项目</button>
        </Popup>
      </div>
      <AgentSwitcher engines={engines} agentId={agentId} disabled={agentDisabled} onSelect={onAgent} onRefreshEngines={onRefreshEngines} />
      {isolation}
    </div>
    {children}
  </section>;
}
