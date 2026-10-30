import { useEffect, useMemo, useRef, useState } from 'react';
import { Input, Modal, ModalContent } from '@nextui-org/react';
import { FolderClosed, MessageCircle, Search as SearchIcon, X } from 'lucide-react';
import type { Session } from '../lib';
import type { Workspace } from '../backend';
import { IconButton } from './ui';
import { sessionUpdatedLabel } from '../search';

export default function Search({ open, onClose, sessions, activeId, onSession, onWorkspace, workspaces }: { open: boolean; onClose: () => void; sessions: Session[]; activeId: string | null; onSession: (id: string) => void; onWorkspace: (hash: string) => void; workspaces: Workspace[] }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const resultsRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => {
    const match = query.trim().toLowerCase();
    return { workspaces: workspaces.filter(item => `${item.name} ${item.path}`.toLowerCase().includes(match)), sessions: sessions.filter(item => `${item.title} ${item.workspace}`.toLowerCase().includes(match)) };
  }, [query, sessions, workspaces]);
  const options = useMemo(() => [...groups.workspaces.map(item => ({ id: item.hash, type: 'workspace' })), ...groups.sessions.map(item => ({ id: item.id, type: 'session' }))], [groups]);
  function choose(index: number) { const item = options[index]; if (!item) return; if (item.type === 'workspace') onWorkspace(item.id); else onSession(item.id); onClose(); }
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSelected(index => options.length ? (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length : 0); }
      if (event.key === 'Enter') { event.preventDefault(); choose(selected); }
    }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  });
  useEffect(() => { if (open) { setQuery(''); setSelected(0); } }, [open]);
  useEffect(() => {
    if (open) resultsRef.current?.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  }, [open, selected]);
  return <Modal isOpen={open} onClose={onClose} hideCloseButton placement="center" backdrop="opaque" classNames={{ wrapper: 'search-wrapper', base: 'search-modal', backdrop: 'modal-backdrop' }} aria-label="搜索会话或工作区"><ModalContent>
    <div className="search-heading"><h1>搜索会话或工作区</h1><IconButton label="关闭搜索" onClick={onClose}><X size="1.25rem" /></IconButton></div>
    <Input autoFocus aria-label="搜索会话或工作区" placeholder="搜索会话或工作区…" startContent={<SearchIcon size="1rem" className="search-input-icon" />} value={query} onValueChange={value => { setQuery(value); setSelected(0); }} variant="bordered" classNames={{ base: 'search-input', inputWrapper: 'search-input-wrapper', input: 'search-input-element' }} />
    <div className="search-results" ref={resultsRef}>{groups.workspaces.length > 0 && <div className="search-group-label">工作区 <span>{groups.workspaces.length}</span></div>}{groups.workspaces.map((item, index) => <button key={item.hash} className={`workspace-result ${selected === index ? 'selected' : ''}`} onMouseEnter={() => setSelected(index)} onClick={() => choose(index)}>{item.kind === 'chat' ? <MessageCircle size="1rem" /> : <FolderClosed size="1rem" />}<span className="search-result-copy"><strong>{item.name}</strong><span title={item.path}>{item.path || (item.kind === 'chat' ? '不绑定工作区' : '')}</span></span></button>)}
      {groups.sessions.length > 0 && <div className={`search-group-label ${groups.workspaces.length ? 'session-label' : ''}`}>会话 <span>{groups.sessions.length}</span></div>}{groups.sessions.map((item, index) => <button key={item.id} className={`session-result ${selected === groups.workspaces.length + index ? 'selected' : ''} ${activeId === item.id ? 'current' : ''}`} onMouseEnter={() => setSelected(groups.workspaces.length + index)} onClick={() => choose(groups.workspaces.length + index)}><MessageCircle size="1rem" /><span className="search-result-copy"><strong>{item.title}</strong><span>{item.workspace}</span></span><time title={item.mtime ? new Date(item.mtime).toLocaleString('zh-CN') : undefined}>{sessionUpdatedLabel(item.mtime)}</time></button>)}
      {options.length === 0 && <div className="no-results">没有找到“{query}”相关的会话或工作区</div>}
    </div><footer className="search-footer"><kbd>↑</kbd><kbd>↓</kbd> 选择 <span>·</span><kbd>Enter</kbd> 打开 <span>·</span><kbd>Esc</kbd> 关闭</footer>
  </ModalContent></Modal>;
}
