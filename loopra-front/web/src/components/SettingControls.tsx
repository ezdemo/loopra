import { Accordion, AccordionItem, Input, Select, SelectItem, SelectSection, Switch, Tab, Tabs, Textarea } from '@nextui-org/react';
import type { SelectProps } from '@nextui-org/react';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ModelOption } from '../composer';
import { useAppMotion } from './Motion';

function useSelectPopover() {
  const ref = useRef<HTMLSelectElement>(null);
  const [width, setWidth] = useState<number>();
  const { enabled } = useAppMotion();
  useLayoutEffect(() => {
    // NextUI forwards this ref to the hidden native select, not its base.
    // Measure the visible trigger before the portal mounts.
    const trigger = ref.current?.closest('[data-slot="base"]')?.querySelector<HTMLButtonElement>('[data-slot="trigger"]');
    if (!trigger) return;
    const measure = () => setWidth(trigger.offsetWidth || undefined);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(trigger);
    return () => observer.disconnect();
  }, []);
  const popoverProps: SelectProps['popoverProps'] = {
    classNames: { content: 'settings-select-popover' },
    style: { width },
    motionProps: {
      // Framer 11's accelerated opacity animation cancels before its final
      // inline style is painted in this browser. onUpdate keeps it on the JS
      // renderer, avoiding a frame reverting to the initial opacity of zero.
      onUpdate: () => undefined,
      variants: {
        initial: { opacity: 0, transform: 'none' },
        enter: { opacity: 1, transform: 'none', transition: { duration: enabled ? 0.14 : 0, ease: 'easeOut' } },
        exit: { opacity: 0, transform: 'none', transition: { duration: enabled ? 0.1 : 0 } },
      },
    },
  };
  return { ref, popoverProps };
}

export function SettingRow({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <div className="setting-row" data-setting-title={title} tabIndex={-1}><div><div className="setting-label">{title}</div>{description && <p>{description}</p>}</div><div className="setting-control">{children}</div></div>;
}
export function SettingSwitch({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return <Switch aria-label={label} isSelected={value} onValueChange={onChange} size="sm" color="primary" className="settings-next-switch" />;
}
export function Field({ label, value, onChange, placeholder, type = 'text', min, max, step, readOnly }: { label: string; value: string | number; onChange: (value: string) => void; placeholder?: string; type?: string; min?: number; max?: number; step?: number; readOnly?: boolean }) {
  return <Input isReadOnly={readOnly} size="md" radius="lg" label={label} labelPlacement="outside" placeholder={placeholder || ' '} type={type} autoComplete="off" value={String(value)} onValueChange={onChange} min={min} max={max} step={step} variant="bordered" className="settings-field" />;
}
export function TextField({ label, value, onChange, placeholder, rows = 3 }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; rows?: number }) {
  return <Textarea size="md" radius="lg" label={label} labelPlacement="outside" value={value} onValueChange={onChange} placeholder={placeholder || ' '} minRows={rows} maxRows={12} variant="bordered" className="settings-field" />;
}
export function SelectField({ label, value, onChange, options, compact = false, startContent }: { label: string; value: string; onChange: (value: string) => void; options: (string | { value: string; label: string })[]; compact?: boolean; startContent?: ReactNode }) {
  const popover = useSelectPopover();
  const items = options.map(option => typeof option === 'string' ? { value: option, label: option } : option);
  return <Select {...popover} aria-label={compact ? label : undefined} label={compact ? undefined : label} labelPlacement="outside" placeholder="请选择" size="md" variant="bordered" radius="lg" startContent={startContent} disallowEmptySelection selectedKeys={items.some(item => item.value === value) ? [`option:${value}`] : []} onSelectionChange={keys => { const key = Array.from(keys)[0]; if (key !== undefined) onChange(String(key).slice(7)); }} className={`settings-next-select ${compact ? 'settings-compact-select' : ''}`}>
    {items.map(item => <SelectItem key={`option:${item.value}`} textValue={item.label}>{item.label}</SelectItem>)}
  </Select>;
}
export function ModelSelect({ label, value, onChange, models, optional = false }: { label: string; value: string; onChange: (value: string) => void; models: ModelOption[]; optional?: boolean }) {
  const popover = useSelectPopover();
  const groups = [...new Set(models.map(model => model.providerId))];
  const hasValue = models.some(model => model.id === value);
  return <Select {...popover} label={label} labelPlacement="outside" placeholder="请选择模型" size="md" variant="bordered" radius="lg" disallowEmptySelection selectedKeys={hasValue ? [`model:${value}`] : optional ? ['none'] : []} onSelectionChange={keys => { const key = Array.from(keys)[0]; if (key !== undefined) onChange(key === 'none' ? '' : String(key).slice(6)); }} className="settings-next-select">
    {[
      ...(optional ? [<SelectItem key="none" textValue="不启用 / 继承主模型">不启用 / 继承主模型</SelectItem>] : []),
      ...groups.map(id => <SelectSection key={id} title={models.find(model => model.providerId === id)?.provider}>{models.filter(model => model.providerId === id).map(model => <SelectItem key={`model:${model.id}`} textValue={model.name}>{model.name}</SelectItem>)}</SelectSection>),
    ]}
  </Select>;
}
export function SettingSegments({ label, options, value, onChange }: { label: string; options: string[]; value: string; onChange: (value: string) => void }) {
  return <Tabs aria-label={label} selectedKey={value} onSelectionChange={key => onChange(String(key))} size="sm" radius="lg" className="settings-next-tabs">{options.map(option => <Tab key={option} title={option} />)}</Tabs>;
}
export function SettingDisclosure({ heading, children, className = '' }: { heading: string; children: ReactNode; className?: string }) {
  const { enabled } = useAppMotion();
  return <Accordion isCompact disableAnimation={!enabled} className={`settings-next-accordion ${className}`} itemClasses={{ trigger: 'settings-accordion-trigger', title: 'settings-accordion-title', content: 'settings-accordion-content' }}><AccordionItem key="details" aria-label={heading} title={heading}>{children}</AccordionItem></Accordion>;
}
export function PageHeader({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return <div className="rich-settings-heading"><div><h2>{title}</h2><p>{description}</p></div>{children}</div>;
}
export function EmptySetting({ children }: { children: ReactNode }) { return <div className="rich-settings-empty">{children}</div>; }
