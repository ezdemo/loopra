import { useEffect, useId, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, CornerDownRight, ListEnd, MoreHorizontal, Paperclip, Pencil, Trash2 } from 'lucide-react';
import type { QueuedMessage } from '../composer';

type Props = {
  queue: QueuedMessage[];
  onRemove: (id: string) => void;
  onGuide: (id: string) => void;
  onEdit: (id: string) => void;
  onMove: (id: string, targetId: string) => void;
};

export default function ComposerQueue({ queue, onRemove, onGuide, onEdit, onMove }: Props) {
  const { t } = useTranslation();
  const [menu, setMenu] = useState<{ id: string; left: number; top: number; above: boolean } | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const listId = useId();
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const dismiss = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node) && !menuTrigger.current?.contains(event.target as Node)) setMenu(null);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setMenu(null); menuTrigger.current?.focus(); }
    };
    const reposition = () => setMenu(null);
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [menu]);

  function openMenu(event: MouseEvent<HTMLButtonElement>, id: string) {
    if (menu?.id === id) { setMenu(null); return; }
    menuTrigger.current = event.currentTarget;
    const bounds = event.currentTarget.getBoundingClientRect();
    const above = bounds.bottom + 144 > window.innerHeight;
    setMenu({ id, left: Math.max(8, Math.min(bounds.right - 184, window.innerWidth - 192)), top: above ? bounds.top - 6 : bounds.bottom + 6, above });
  }
  function menuKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }

  function startEdit(item: QueuedMessage) {
    setMenu(null);
    onEdit(item.id);
  }
  function drop(event: DragEvent, targetId: string) {
    if (!dragged) return;
    event.preventDefault(); event.stopPropagation();
    onMove(dragged, targetId);
    setDragged(null); setDropTarget(null);
  }

  if (!queue.length) return null;
  const menuIndex = queue.findIndex(item => item.id === menu?.id);
  return <section className="composer-queue" aria-label={t('composer.queuedMessages', { count: queue.length })}>
    <span className="sr-only">{t('composer.queueDescription')}</span>
      <ol className="composer-queue-list">
        {queue.map((item, index) => {
          const files = [...new Set([...item.context.files, ...(item.context.attachments || []).map(file => file.name)])];
          return <li key={item.id} data-queue-id={item.id} draggable
            className={`${dragged === item.id ? 'dragging' : ''} ${dropTarget === item.id && dragged !== item.id ? 'drag-over' : ''}`}
            onDragStart={event => {
              event.stopPropagation(); event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', item.id);
              setMenu(null); setDragged(item.id); setDropTarget(null);
            }}
            onDragOver={event => {
              if (!dragged || dragged === item.id) return;
              event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
              setDropTarget(item.id);
            }}
            onDragLeave={event => {
              if (event.relatedTarget instanceof window.Node && event.currentTarget.contains(event.relatedTarget)) return;
              setDropTarget(current => current === item.id ? null : current);
            }}
            onDragEnd={() => { setDragged(null); setDropTarget(null); }}
            onDrop={event => drop(event, item.id)}>
            <div className="composer-queue-row">
              <ListEnd size="0.9375rem" className="composer-queue-item-icon" aria-hidden="true" />
              <div className="composer-queue-preview">
                <span className="composer-queue-text">{item.text ? item.text.slice(0, 160) : t('composer.attachmentOnlyMessage')}</span>
                {files.length > 0 && <span className="composer-queue-attachments" title={files.join('\n')}><Paperclip size="0.75rem" />{files.length}</span>}
              </div>
              <div className="composer-queue-actions">
                <button type="button" className="composer-queue-guide" title={t('composer.guideMessage')} onClick={() => onGuide(item.id)}><CornerDownRight size="0.9375rem" />{t('composer.guide')}</button>
                <button type="button" className="composer-queue-action composer-queue-remove" title={t('composer.withdraw')} aria-label={t('composer.withdrawMessage', { index: index + 1 })} onClick={() => onRemove(item.id)}><Trash2 size="0.9375rem" /></button>
                <button type="button" className="composer-queue-action composer-queue-more" title={t('composer.moreActions')} aria-label={t('composer.moreActionsFor', { index: index + 1 })} aria-haspopup="menu" aria-expanded={menu?.id === item.id} aria-controls={menu?.id === item.id ? `${listId}-menu` : undefined} onClick={event => openMenu(event, item.id)}><MoreHorizontal size="1rem" /></button>
              </div>
            </div>
          </li>;
        })}
      </ol>
    {menu && menuIndex >= 0 && createPortal(<div ref={menuRef} id={`${listId}-menu`} className="composer-queue-menu" role="menu" aria-label={t('composer.queueActions')} data-above={menu.above} style={{ left: menu.left, top: menu.top }} onKeyDown={menuKeys}>
      <button type="button" role="menuitem" onClick={() => startEdit(queue[menuIndex])}><Pencil size="1rem" />{t('composer.editMessage')}</button>
      <button type="button" role="menuitem" disabled={menuIndex === 0} onClick={() => { onMove(menu.id, queue[menuIndex - 1].id); setMenu(null); menuTrigger.current?.focus(); }}><ArrowUp size="1rem" />{t('composer.moveUp')}</button>
      <button type="button" role="menuitem" disabled={menuIndex === queue.length - 1} onClick={() => { onMove(menu.id, queue[menuIndex + 1].id); setMenu(null); menuTrigger.current?.focus(); }}><ArrowDown size="1rem" />{t('composer.moveDown')}</button>
    </div>, document.body)}
  </section>;
}
