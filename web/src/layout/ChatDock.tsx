import { ArrowDownToLine, FoldVertical } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  return <>
    {items.length > 0 && <nav className="msg-thumb-dock" aria-label={t('chat.messageLocator')}><div className="thumb-dock-inner">
      {items.map(item => <button key={item.id} type="button" className="thumb-item" title={item.text} onClick={() => onJump(item.id)}>
        <span className="thumb-indicator" /><span className="thumb-preview">{truncatePreview(item.text)}</span>
      </button>)}
    </div></nav>}
    {showScrollButton && <button type="button" className="scroll-bottom-btn" title={t('chat.scrollBottom')} aria-label={t('chat.scrollBottom')} onClick={onScrollBottom}><ArrowDownToLine size="1rem" /></button>}
    {hasMessages && <button type="button" className="collapse-all-btn" title={t('chat.collapseAll')} aria-label={t('chat.collapseAll')} onClick={onCollapseAll}><FoldVertical size="1rem" /></button>}
  </>;
}
