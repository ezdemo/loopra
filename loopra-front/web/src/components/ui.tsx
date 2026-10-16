import type { ReactNode } from 'react';
import { Button, Tooltip } from '@nextui-org/react';
import { SelectionIndicator } from './Motion';

export function IconButton({ label, children, onClick, className = '', active = false }: { label: string; children: ReactNode; onClick?: () => void; className?: string; active?: boolean }) {
  return <Tooltip content={label} delay={600} closeDelay={0} classNames={{ content: 'app-tooltip' }}><Button isIconOnly variant="light" aria-label={label} title={label} onPress={onClick} className={`icon-button ${active ? 'active' : ''} ${className}`}>{children}</Button></Tooltip>;
}

export function LoopraMark({ small = false }: { small?: boolean }) {
  return <span className={`loopra-mark ${small ? 'loopra-mark-small' : ''}`} aria-hidden="true"><img src={`${import.meta.env.BASE_URL}loopra-logo.svg`} alt="" draggable={false} /></span>;
}

export function Segmented({ options, value, onChange, label }: { options: string[]; value: string; onChange: (value: string) => void; label: string }) {
  return <div className="segmented" role="group" aria-label={label}>{options.map(option => <button key={option} type="button" className={value === option ? 'selected' : ''} aria-pressed={value === option} onClick={() => onChange(option)}>{value === option && <SelectionIndicator />}<span className="segment-label">{option}</span></button>)}</div>;
}
