import { ArrowDownToLine, FoldVertical } from 'lucide-react';
import { truncatePreview } from '../chat';

export type DockItem = { id: string; text: string };

type ChatDockProps = {
  items: DockItem[];
  showScrollButton: boolean;
  hasMessages: boolean;
  onJump: (id: string) => void;
  onScrollBottom: () => void;
  onCollapseAll: () => void;
};

/** Floating helpers inside the chat pane: message locator, jump-to-bottom and collapse-all. */
export default function ChatDock({ items, showScrollButton, hasMessages, onJump, onScrollBottom, onCollapseAll }: ChatDockProps) {
  return <>
    {items.length > 0 && <nav className="msg-thumb-dock" aria-label="消息定位"><div className="thumb-dock-inner">
      {items.map(item => <button key={item.id} type="button" className="thumb-item" title={item.text} onClick={() => onJump(item.id)}>
        <span className="thumb-indicator" /><span className="thumb-preview">{truncatePreview(item.text)}</span>
      </button>)}
    </div></nav>}
    {showScrollButton && <button type="button" className="scroll-bottom-btn" title="滚动到底部" aria-label="滚动到底部" onClick={onScrollBottom}><ArrowDownToLine size="1rem" /></button>}
    {hasMessages && <button type="button" className="collapse-all-btn" title="一键折叠所有展开的块" aria-label="一键折叠所有展开的块" onClick={onCollapseAll}><FoldVertical size="1rem" /></button>}
  </>;
}
