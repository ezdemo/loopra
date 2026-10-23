import { Accordion, AccordionItem, Button, Input, Select, SelectItem, SelectSection, Switch, Tab, Tabs, Textarea } from '@nextui-org/react';
import type { InputProps, SelectProps, TextAreaProps } from '@nextui-org/react';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, Blocks, Braces, Package, Plug, Sparkles, Wrench } from 'lucide-react';
import type { ModelOption } from '../composer';
import { useAppMotion } from './Motion';

function useSelectPopover() {
  const ref = useRef<HTMLSelectElement>(null);
  const [width, setWidth] = useState<number>();
  const [open, setOpen] = useState(false);
  const { enabled } = useAppMotion();
  useLayoutEffect(() => {
    if (!open) return;
    // NextUI forwards this ref to the hidden native select, not its base.
    // Measure only when opening the menu, not while mounting the whole settings page.
    const trigger = ref.current?.closest('[data-slot="base"]')?.querySelector<HTMLButtonElement>('[data-slot="trigger"]');
    if (!trigger) return;
    const measure = () => setWidth(trigger.offsetWidth || undefined);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(trigger);
    return () => observer.disconnect();
  }, [open]);
  const popoverProps: SelectProps['popoverProps'] = {
    disableAnimation: !enabled,
    // Focusing the hidden select can scroll the form as the menu opens.
    // Keep the menu open so this cannot dismiss it before a selection.
    shouldCloseOnScroll: false,
    classNames: { content: 'settings-select-popover' },
    style: { width },
    motionProps: enabled ? {
      // Framer 11's accelerated opacity animation cancels before its final
      // inline style is painted in this browser. onUpdate keeps it on the JS
      // renderer, avoiding a frame reverting to the initial opacity of zero.
      onUpdate: () => undefined,
      variants: {
        initial: { opacity: 0, transform: 'none' },
        enter: { opacity: 1, transform: 'none', transition: { duration: 0.14, ease: 'easeOut' } },
        exit: { opacity: 0, transform: 'none', transition: { duration: 0.1 } },
      },
    } : undefined,
  };
  return { ref, popoverProps, onOpenChange: setOpen };
}

export function SettingRow({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <div className="setting-row" data-setting-title={title} tabIndex={-1}><div><div className="setting-label">{title}</div>{description && <p>{description}</p>}</div><div className="setting-control">{children}</div></div>;
}
export function SettingSwitch({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return <Switch aria-label={label} isSelected={value} onValueChange={onChange} size="sm" color="primary" className="settings-next-switch" />;
}
type FieldProps = Omit<InputProps, 'label' | 'value' | 'onChange' | 'onValueChange'> & { label: string; value: string | number; onChange: (value: string) => void; readOnly?: boolean; required?: boolean; disabled?: boolean };
export function Field({ label, value, onChange, placeholder, readOnly, required, disabled, className = '', ...props }: FieldProps) {
  return <Input {...props} isReadOnly={readOnly || props.isReadOnly} isRequired={required || props.isRequired} isDisabled={disabled || props.isDisabled} validationBehavior="native" size="md" radius="lg" label={label} labelPlacement="outside" placeholder={placeholder || ' '} autoComplete="off" value={String(value)} onValueChange={onChange} variant="bordered" className={`settings-field ${className}`} />;
}
type TextFieldProps = Omit<TextAreaProps, 'label' | 'value' | 'onChange' | 'onValueChange' | 'rows'> & { label: string; value: string; onChange: (value: string) => void; rows?: number; required?: boolean; disabled?: boolean };
export function TextField({ label, value, onChange, placeholder, rows = 3, required, disabled, className = '', ...props }: TextFieldProps) {
  return <Textarea {...props} isRequired={required || props.isRequired} isDisabled={disabled || props.isDisabled} validationBehavior="native" size="md" radius="lg" label={label} labelPlacement="outside" value={value} onValueChange={onChange} placeholder={placeholder || ' '} minRows={rows} maxRows={Math.max(rows, 12)} variant="bordered" className={`settings-field ${className}`} />;
}
export function SelectField({ label, value, onChange, options, compact = false, startContent, required, disabled }: { label: string; value: string; onChange: (value: string) => void; options: (string | { value: string; label: string })[]; compact?: boolean; startContent?: ReactNode; required?: boolean; disabled?: boolean }) {
  const popover = useSelectPopover();
  const items = options.map(option => typeof option === 'string' ? { value: option, label: option } : option);
  return <Select {...popover} isRequired={required} isDisabled={disabled} validationBehavior="native" aria-label={compact ? label : undefined} label={compact ? undefined : label} labelPlacement="outside" placeholder="请选择" size="md" variant="bordered" radius="lg" startContent={startContent} disallowEmptySelection selectedKeys={items.some(item => item.value === value) && (!required || value !== '') ? [`option:${value}`] : []} onSelectionChange={keys => { const key = Array.from(keys)[0]; if (key !== undefined) onChange(String(key).slice(7)); }} className={`settings-next-select ${compact ? 'settings-compact-select' : ''}`}>
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
export function SettingDisclosure({ heading, children, className = '', defaultExpanded = false }: { heading: string; children: ReactNode; className?: string; defaultExpanded?: boolean }) {
  const { enabled } = useAppMotion();
  return <Accordion isCompact defaultExpandedKeys={defaultExpanded ? ['details'] : []} disableAnimation={!enabled} className={`settings-next-accordion ${className}`} itemClasses={{ trigger: 'settings-accordion-trigger', title: 'settings-accordion-title', content: 'settings-accordion-content' }}><AccordionItem key="details" aria-label={heading} title={heading}>{children}</AccordionItem></Accordion>;
}
type ResourceKind = 'tool' | 'skill' | 'plugin' | 'extension' | 'mcp' | 'openapi';
const resourceIcons = { tool: Wrench, skill: Sparkles, plugin: Blocks, extension: Package, mcp: Plug, openapi: Braces };
export function ResourceIcon({ kind }: { kind: ResourceKind }) {
  const Icon = resourceIcons[kind];
  return <span className="resource-icon" aria-hidden="true"><Icon size="1.125rem" strokeWidth={1.7} /></span>;
}
export function ResourceEmpty({ kind, title, children }: { kind: ResourceKind; title: string; children: ReactNode }) {
  return <div className="resource-empty"><ResourceIcon kind={kind} /><h3>{title}</h3><p>{children}</p></div>;
}
export function PageActions({ title, children, onBack, backLabel = '返回列表' }: { title: string; children?: ReactNode; onBack?: () => void; backLabel?: string }) {
  return <header className="resource-page-heading">{onBack ? <div className="resource-page-navigation"><Button size="sm" variant="light" className="resource-page-back" startContent={<ArrowLeft size="1rem" />} aria-label={backLabel} onPress={onBack}>返回列表</Button><h2>{title}</h2></div> : <h2>{title}</h2>}{children && <div className="resource-page-actions">{children}</div>}</header>;
}
export function EmptySetting({ children }: { children: ReactNode }) { return <div className="rich-settings-empty">{children}</div>; }
