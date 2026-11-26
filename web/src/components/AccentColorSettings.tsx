import { useState } from 'react';
import type { CSSProperties } from 'react';
import { Button, Popover, PopoverContent, PopoverTrigger } from '@nextui-org/react';
import { Plus } from 'lucide-react';
import { defaultAccentSwatch, normalizeAccentColor } from '../accent-color';
import { Field } from './SettingControls';

const presets = [
  { label: '默认靛蓝', color: '' },
  { label: '蓝色', color: '#2563eb' },
  { label: '青色', color: '#0d9488' },
  { label: '绿色', color: '#16a34a' },
  { label: '橙色', color: '#ea580c' },
  { label: '粉色', color: '#db2777' },
  { label: '石墨灰', color: '#52525b' },
];

export function AccentColorSettings({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const color = normalizeAccentColor(value);
  const custom = !presets.some(preset => preset.color === color);
  const customLabel = custom ? `自定义强调色（当前 ${color}）` : '自定义强调色';
  const draftColor = normalizeAccentColor(draft);

  return <div className="accent-color-options" role="group" aria-label="强调色">
    {presets.map(preset => <Button key={preset.label} type="button" isIconOnly size="sm" variant="light" radius="full" className="accent-color-option" aria-label={preset.label} title={preset.label} aria-pressed={color === preset.color} onPress={() => onChange(preset.color)}>
      <span className="accent-color-swatch" aria-hidden="true" style={{ '--accent-swatch': preset.color || defaultAccentSwatch } as CSSProperties} />
    </Button>)}
    <Popover placement="bottom-end" isOpen={open} onOpenChange={next => {
      if (next) setDraft(color || defaultAccentSwatch);
      setOpen(next);
    }}>
      <PopoverTrigger>
        <Button type="button" isIconOnly size="sm" variant="light" radius="full" className="accent-color-option" aria-label={customLabel} title={customLabel}>
          <span className="accent-color-custom-mark" data-selected={custom} aria-hidden="true"><Plus size="0.75rem" /></span>
        </Button>
      </PopoverTrigger>
      <PopoverContent aria-label="自定义强调色" className="accent-color-popover">
        <form className="accent-color-editor" onSubmit={event => {
          event.preventDefault();
          if (!draftColor) return;
          onChange(draftColor);
          setOpen(false);
        }}>
          <div className="accent-color-editor-fields">
            <input type="color" aria-label="选择颜色" value={draftColor || color || defaultAccentSwatch} onChange={event => setDraft(event.target.value)} />
            <Field label="十六进制颜色" placeholder="#rrggbb" value={draft} onChange={setDraft} spellCheck={false} />
          </div>
          <Button type="submit" size="sm" color="primary" isDisabled={!draftColor}>应用</Button>
        </form>
      </PopoverContent>
    </Popover>
  </div>;
}
