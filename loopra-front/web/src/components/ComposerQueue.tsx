import { useEffect, useId, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
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
  return <section className="composer-queue" aria-label={`排队消息 ${queue.length} 条`}>
    <span className="sr-only">当前回复结束后按顺序自动发送，可拖拽调整顺序</span>
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
              <button type="button" className="composer-queue-preview" title="恢复到输入框编辑" onClick={() => startEdit(item)}>
                <span className="composer-queue-text">{item.text ? item.text.slice(0, 160) : '仅附件消息'}</span>
                {files.length > 0 && <span className="composer-queue-attachments" title={files.join('\n')}><Paperclip size="0.75rem" />{files.length}</span>}
              </button>
              <div className="composer-queue-actions">
                <button type="button" className="composer-queue-guide" title="停止当前生成，优先发送这条消息" onClick={() => onGuide(item.id)}><CornerDownRight size="0.9375rem" />引导</button>
                <button type="button" className="composer-queue-action composer-queue-remove" title="撤回，不再发送" aria-label={`撤回第 ${index + 1} 条消息`} onClick={() => onRemove(item.id)}><Trash2 size="0.9375rem" /></button>
                <button type="button" className="composer-queue-action composer-queue-more" title="更多操作" aria-label={`第 ${index + 1} 条消息的更多操作`} aria-haspopup="menu" aria-expanded={menu?.id === item.id} aria-controls={menu?.id === item.id ? `${listId}-menu` : undefined} onClick={event => openMenu(event, item.id)}><MoreHorizontal size="1rem" /></button>
              </div>
            </div>
          </li>;
        })}
      </ol>
    {menu && menuIndex >= 0 && createPortal(<div ref={menuRef} id={`${listId}-menu`} className="composer-queue-menu" role="menu" aria-label="排队消息操作" data-above={menu.above} style={{ left: menu.left, top: menu.top }} onKeyDown={menuKeys}>
      <button type="button" role="menuitem" onClick={() => startEdit(queue[menuIndex])}><Pencil size="1rem" />编辑消息</button>
      <button type="button" role="menuitem" disabled={menuIndex === 0} onClick={() => { onMove(menu.id, queue[menuIndex - 1].id); setMenu(null); menuTrigger.current?.focus(); }}><ArrowUp size="1rem" />上移</button>
      <button type="button" role="menuitem" disabled={menuIndex === queue.length - 1} onClick={() => { onMove(menu.id, queue[menuIndex + 1].id); setMenu(null); menuTrigger.current?.focus(); }}><ArrowDown size="1rem" />下移</button>
    </div>, document.body)}
  </section>;
}
