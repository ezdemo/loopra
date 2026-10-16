import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { SquareTerminal } from 'lucide-react';
import type { LoopraClient } from '../backend';
import { useBashSessions } from '../useBashSessions';
import { TerminalPanel } from './Panels';
import BackgroundTaskLog from './BackgroundTaskLog';

type Props = {
  api: LoopraClient; workspaceHash: string; connected: boolean; open: boolean;
  onOpenChange: (open: boolean) => void; notify: (message: string) => void;
  children: ReactNode;
};

export default function BackgroundTasks({ api, workspaceHash, connected, open, onOpenChange, notify, children }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const [unread, setUnread] = useState(false);
  const tasks = useBashSessions(api, workspaceHash, connected);
  const taskCount = tasks.sessions.length;
  const [logOpen, setLogOpen] = useState(false);
  const [placement, setPlacement] = useState({ below: false, height: 400 });
  function close() { onOpenChange(false); trigger.current?.focus(); }

  useEffect(() => {
    const onStart = () => { if (!open && !logOpen) setUnread(true); };
    window.addEventListener('loopra:bash-start', onStart);
    return () => window.removeEventListener('loopra:bash-start', onStart);
  }, [open, logOpen]);
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const bounds = root.current?.getBoundingClientRect();
      if (!bounds) return;
      const above = bounds.top - 104;
      const below = above < 160;
      setPlacement({ below, height: Math.max(96, Math.min(400, below ? window.innerHeight - bounds.top - 16 : above)) });
    };
    position();
    const observer = new ResizeObserver(position);
    if (root.current) observer.observe(root.current);
    window.addEventListener('resize', position);
    return () => { observer.disconnect(); window.removeEventListener('resize', position); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    setUnread(false);
    dialog.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!dialog.current?.contains(target) && !trigger.current?.contains(target)) onOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onOpenChange(false); trigger.current?.focus(); }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onOpenChange]);

  return <div className={`composer-task-anchor${taskCount > 0 ? ' has-tasks' : ''}`} ref={root} data-popover>
    {taskCount > 0 && <button ref={trigger} type="button" className={`background-tasks-trigger${open ? ' active' : ''}`}
      aria-label={unread ? '后台任务，有新任务' : '后台任务'} aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? panelId : undefined} onClick={() => onOpenChange(!open)}>
      <SquareTerminal size="0.875rem" /><span>后台</span>{unread && <i className="background-tasks-unread" aria-hidden="true" />}
    </button>}
    {open && <div ref={dialog} id={panelId} className={`background-tasks-popover${placement.below ? ' below' : ''}`} style={{ '--background-tasks-height': `${placement.height}px` } as CSSProperties} role="dialog" aria-label="后台任务" tabIndex={-1}>
      <TerminalPanel key={workspaceHash} api={api} workspaceHash={workspaceHash} onClose={close} notify={notify} state={tasks} onInspect={() => { onOpenChange(false); setLogOpen(true); }} />
    </div>}
    {children}
    <BackgroundTaskLog state={tasks} open={logOpen} onClose={() => { setLogOpen(false); trigger.current?.focus(); }} notify={notify} />
  </div>;
}
