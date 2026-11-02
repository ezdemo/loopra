import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw, Search } from 'lucide-react';
import { Button, Card, CardBody, CardFooter, CardHeader, Input, Tab, Tabs } from '@nextui-org/react';
import { SelectField } from './SettingControls';

export type CapabilityLibraryProps = { library?: boolean; searchQuery?: string; refreshKey?: number; toolbarTarget?: HTMLElement | null; showType?: boolean };

export function CapabilityControls({ library, target, children }: { library?: boolean; target?: HTMLElement | null; children: ReactNode }) {
  return library ? target ? createPortal(children, target) : null : <div className="capability-toolbar">{children}</div>;
}

export function CapabilitySearch({ value, onChange, label, placeholder = '搜索名称或说明…' }: { value: string; onChange: (value: string) => void; label: string; placeholder?: string }) {
  return <Input type="search" aria-label={label} placeholder={placeholder} value={value} onValueChange={onChange} size="sm" variant="bordered" startContent={<Search size={16} aria-hidden="true" />} classNames={{ base: 'capability-search', inputWrapper: 'capability-search-wrapper', input: 'capability-search-input' }} />;
}

export function CapabilitySelect({ label, value, onChange, options, disabled }: { label: string; value: string; onChange: (value: string) => void; options: { value: string; label: string }[]; disabled?: boolean }) {
  return <div className="capability-select"><SelectField compact label={label} value={value} onChange={onChange} options={options} disabled={disabled} /></div>;
}

export function CapabilityTabs({ label, value, onChange, options, variant = 'solid', className = '' }: { label: string; value: string; onChange: (value: string) => void; options: { value: string; label: ReactNode }[]; variant?: 'solid' | 'underlined'; className?: string }) {
  return <Tabs aria-label={label} selectedKey={value} onSelectionChange={key => onChange(String(key))} variant={variant} size="sm" radius="md" classNames={{ base: className, tabList: 'capability-tab-list', tab: 'capability-tab', cursor: 'capability-tab-cursor', tabContent: 'capability-tab-content' }}>{options.map(option => <Tab key={option.value} title={option.label} />)}</Tabs>;
}

export function CapabilityRefresh({ onClick, disabled = false }: { onClick: () => void; disabled?: boolean }) {
  return <Button type="button" size="sm" isIconOnly variant="light" className="capability-icon-button" aria-label="刷新" title="刷新" isDisabled={disabled} onPress={onClick}><RefreshCw size={16} /></Button>;
}

export function CapabilityCard({ title, description, icon, iconClassName = '', iconStyle, badge, meta, actions, headerActions, children, className = '' }: {
  title: string; description?: string; icon: ReactNode; iconClassName?: string; iconStyle?: CSSProperties;
  badge?: ReactNode; meta?: ReactNode; actions: ReactNode; headerActions?: ReactNode; children?: ReactNode; className?: string;
}) {
  return <Card as="article" shadow="none" className={`capability-card ${className}`}>
    <CardHeader className="capability-card-header">
      <span className={`capability-card-icon ${iconClassName}`} style={iconStyle} aria-hidden="true">{icon}</span>
      <div className="capability-card-title"><h2 title={title}><strong>{title}</strong></h2>{badge && <span className="capability-card-badge">{badge}</span>}</div>
      {headerActions && <div className="capability-card-header-actions">{headerActions}</div>}
    </CardHeader>
    <CardBody className="capability-card-body"><p className="capability-card-description">{description || '暂无说明'}</p>
    {children}
    </CardBody>
    <CardFooter className="capability-card-footer"><span className="capability-card-meta">{meta}</span><div className="capability-card-actions">{actions}</div></CardFooter>
  </Card>;
}
