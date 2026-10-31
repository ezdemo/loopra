import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw, Search } from 'lucide-react';

export type CapabilityLibraryProps = { library?: boolean; searchQuery?: string; refreshKey?: number; toolbarTarget?: HTMLElement | null; showType?: boolean };

export function CapabilityControls({ library, target, children }: { library?: boolean; target?: HTMLElement | null; children: ReactNode }) {
  return library ? target ? createPortal(children, target) : null : <div className="capability-toolbar">{children}</div>;
}

export function CapabilitySearch({ value, onChange, label, placeholder = '搜索名称或说明…' }: { value: string; onChange: (value: string) => void; label: string; placeholder?: string }) {
  return <label className="capability-search"><Search size={16} aria-hidden="true" /><input type="search" aria-label={label} placeholder={placeholder} value={value} onChange={event => onChange(event.target.value)} /></label>;
}

export function CapabilityRefresh({ onClick, disabled = false }: { onClick: () => void; disabled?: boolean }) {
  return <button type="button" className="capability-icon-button" aria-label="刷新" title="刷新" disabled={disabled} onClick={onClick}><RefreshCw size={16} /></button>;
}

export function CapabilityCard({ title, description, icon, iconClassName = '', iconStyle, badge, meta, actions, children, className = '' }: {
  title: string; description?: string; icon: ReactNode; iconClassName?: string; iconStyle?: CSSProperties;
  badge?: ReactNode; meta?: ReactNode; actions: ReactNode; children?: ReactNode; className?: string;
}) {
  return <article className={`capability-card ${className}`}>
    <header className="capability-card-header">
      <span className={`capability-card-icon ${iconClassName}`} style={iconStyle} aria-hidden="true">{icon}</span>
      <div className="capability-card-title"><h2 title={title}><strong>{title}</strong></h2>{badge && <span className="capability-card-badge">{badge}</span>}</div>
    </header>
    <p className="capability-card-description">{description || '暂无说明'}</p>
    {children}
    <footer className="capability-card-footer"><span className="capability-card-meta">{meta}</span><div className="capability-card-actions">{actions}</div></footer>
  </article>;
}
