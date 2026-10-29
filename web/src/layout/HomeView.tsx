import { useRef, type CSSProperties, type ReactNode } from 'react';
import { Check, ChevronDown, FolderClosed, FolderPlus, MessageCircle } from 'lucide-react';
import { Enter, Popup } from '../components/Motion';
import { LoadingSkeleton, LoopraMark } from '../components/ui';
import type { AgentEngine, Workspace } from '../backend';
import AgentSwitcher from './AgentSwitcher';
import { useMenuPlacement } from './menu-placement';

type HomeViewProps = {
  workspaces: Workspace[];
  workspacesLoading?: boolean;
  enginesLoading?: boolean;
  workspace: string;
  workspaceName: string;
  chatMode?: boolean;
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
  onTaskToolbarMount?: (element: HTMLDivElement | null) => void;
  children: ReactNode;
};

export default function HomeView({ workspaces, workspacesLoading, enginesLoading, workspace, workspaceName, chatMode, menuOpen, onToggleMenu, onSelect, onManage,
  engines, agentId, agentDisabled, onAgent, onRefreshEngines, isolation, onTaskToolbarMount, children }: HomeViewProps) {
  // The menu opens upward by default. It is capped to the room above (the list
  // scrolls inside) and only flips below the anchor when the top of the window
  // leaves too little usable height. Heading and footer stay put either way.
  const anchorRef = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(menuOpen, anchorRef);
  const placementStyle = (placement.maxHeight ? { '--menu-max-height': `${placement.maxHeight}px` } : undefined) as CSSProperties | undefined;
  return <section className="welcome-shell">
    <Enter as="div" className="welcome-intro"><h1 className="welcome-logo" aria-label="Loopra"><LoopraMark />Loopra</h1></Enter>
    <div className="welcome-switchers">
      {workspacesLoading ? <div className="welcome-selector-loading" role="status" aria-label="正在加载工作区"><LoadingSkeleton className="skeleton-selector-icon" /><LoadingSkeleton className="skeleton-selector-text" /></div> : <div ref={anchorRef} className="workspace-selector menu-anchor" data-popover data-placement={placement.side} style={placementStyle}>
        <button onClick={onToggleMenu}>{workspaces.find(item => item.hash === workspace)?.kind === 'chat' ? <MessageCircle size="1rem" /> : <FolderClosed size="1rem" />}{workspaceName}<ChevronDown size="0.875rem" /></button>
        <Popup open={menuOpen} className="popup workspace-menu">
          <h3>选择工作区或模式</h3>
          <div className="workspace-menu-list">
            {workspaces.map(item => <button key={item.hash} onClick={() => onSelect(item.hash)}>{item.kind === 'chat' ? <MessageCircle size="1rem" /> : <FolderClosed size="1rem" />}{item.name}{workspace === item.hash && <Check size="1rem" />}</button>)}
            {!workspaces.length && <p className="composer-empty">暂无可用项目</p>}
          </div>
          <hr /><button onClick={onManage}><FolderPlus size="1rem" />管理项目</button>
        </Popup>
      </div>}
      {enginesLoading ? <div className="welcome-selector-loading" role="status" aria-label="正在加载智能体"><LoadingSkeleton className="skeleton-selector-icon" /><LoadingSkeleton className="skeleton-selector-text" /></div> : <AgentSwitcher engines={engines} agentId={agentId} disabled={agentDisabled} disabledReason={chatMode ? '纯聊天仅支持 Loopra Native；切换到项目后可选择其他 Agent' : undefined} onSelect={onAgent} onRefreshEngines={onRefreshEngines} />}
      <div className="welcome-task-toolbar" ref={onTaskToolbarMount} />
      {workspacesLoading ? <div className="welcome-selector-loading welcome-isolation-loading" role="status" aria-label="正在加载分支配置"><LoadingSkeleton className="skeleton-isolation" /></div> : isolation}
    </div>
    {children}
  </section>;
}
