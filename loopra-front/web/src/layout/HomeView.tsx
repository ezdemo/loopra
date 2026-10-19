import type { ReactNode } from 'react';
import { Check, ChevronDown, FolderClosed, FolderPlus } from 'lucide-react';
import { Enter, Popup } from '../components/Motion';
import { LoopraMark } from '../components/ui';
import type { AgentEngine, Workspace } from '../backend';
import AgentSwitcher from './AgentSwitcher';

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
  children: ReactNode;
};

export default function HomeView({ workspaces, workspace, workspaceName, menuOpen, onToggleMenu, onSelect, onManage,
  engines, agentId, agentDisabled, onAgent, children }: HomeViewProps) {
  return <section className="welcome-shell">
    <Enter as="div" className="welcome-intro"><h1 className="welcome-logo" aria-label="Loopra"><LoopraMark />Loopra</h1></Enter>
    <div className="welcome-switchers">
      <div className="workspace-selector menu-anchor" data-popover>
        <button onClick={onToggleMenu}><FolderClosed size="1rem" />{workspaceName}<ChevronDown size="0.875rem" /></button>
        <Popup open={menuOpen} className="popup workspace-menu">
          <h3>选择工作区</h3>
          {workspaces.map(item => <button key={item.hash} onClick={() => onSelect(item.hash)}><FolderClosed size="1rem" />{item.name}{workspace === item.hash && <Check size="1rem" />}</button>)}
          {!workspaces.length && <p className="composer-empty">暂无可用项目</p>}
          <hr />
          <button onClick={onManage}><FolderPlus size="1rem" />管理项目</button>
        </Popup>
      </div>
      <AgentSwitcher engines={engines} agentId={agentId} disabled={agentDisabled} onSelect={onAgent} />
    </div>
    {children}
  </section>;
}
