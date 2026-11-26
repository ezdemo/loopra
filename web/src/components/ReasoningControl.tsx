import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CSSProperties, FormEvent, KeyboardEvent } from 'react';
import { Button, Input, Slider } from '@nextui-org/react';
import { Brain } from 'lucide-react';
import { effortLevels } from '../composer';
import type { AgentEffortLevel } from '../agent-config';

type Props = {
  value: string;
  disabled: boolean;
  onCommit: (value: string) => void | Promise<void>;
  onClose: () => void;
  /** Agent-owned levels (ACP thought_level) instead of Loopra's built-in scale. */
  levels?: AgentEffortLevel[];
  /** ACP select options are closed sets, so external Agents hide the free-form field. */
  allowCustom?: boolean;
  /** Loopra-owned levels use the shared translation; external Agents keep their own text. */
  localizeLevels?: boolean;
};

// Pointer precision is subpixel at the flyout's width; only actual tiers are saved.
const pointerStep = 0.001;
const sliderPosition = (value: number | number[]) => Array.isArray(value) ? value[0] : value;

const knownEffortValues = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'default']);

export default function ReasoningControl({ value, disabled, onCommit, onClose, levels = effortLevels, allowCustom = true, localizeLevels = true }: Props) {
  const { t } = useTranslation();
  levels = localizeLevels ? levels.map(level => knownEffortValues.has(level.value.toLowerCase()) ? { ...level, label: t(`effort.${level.value.toLowerCase()}.label`), description: t(`effort.${level.value.toLowerCase()}.description`) } : level) : levels;
  // Keep pointer updates inside this small control, independent of network saves
  // and the conversation tree. Only a completed gesture persists the selection.
  const [preview, setPreview] = useState<string | null>(null);
  const [dragPosition, setDragPosition] = useState<number | null>(null);
  const [custom, setCustom] = useState(() => allowCustom && levels.some(level => level.value === value) ? '' : allowCustom ? value : '');
  const revision = useRef(0);
  const pending = useRef(0);
  const cancelDrag = useRef(false);
  const lastIndex = levels.length - 1;
  const nearestIndex = (position: number) => Math.max(0, Math.min(lastIndex, Math.round(position)));
  const displayed = (dragPosition === null ? preview : levels[nearestIndex(dragPosition)]?.value) ?? value;
  const index = levels.findIndex(level => level.value === displayed);
  const atMax = index > 0 && index === lastIndex && (dragPosition === null || dragPosition === lastIndex);
  const effort = levels[index];
  // A custom (off-scale) value parks the knob at 0, so the track's spark field stays calm.
  const sparkLevel = Math.max(0, index);
  // A double-digit tier count turns the track into noise; past that the level row wraps.
  const singleRow = levels.length <= 10;

  useEffect(() => {
    if (disabled) setDragPosition(null);
  }, [disabled]);

  async function commit(next: string) {
    const current = ++revision.current;
    setDragPosition(null);
    setCustom('');
    if (next === value && pending.current === 0) { setPreview(null); return; }
    setPreview(next);
    pending.current++;
    try { await onCommit(next); }
    finally {
      pending.current--;
      // An earlier response must not clear a newer optimistic selection.
      if (revision.current === current) setPreview(null);
    }
  }

  function selectPosition(position: number) {
    const level = levels[nearestIndex(position)];
    if (level) void commit(level.value);
  }

  function handleSliderKey(event: KeyboardEvent<HTMLDivElement>) {
    if (disabled || event.altKey || event.ctrlKey || event.metaKey) return;
    let next: number;
    switch (event.key) {
      case 'Home': next = 0; break;
      case 'End': next = lastIndex; break;
      case 'ArrowUp':
      case 'PageUp': next = sparkLevel + 1; break;
      case 'ArrowDown':
      case 'PageDown': next = sparkLevel - 1; break;
      case 'ArrowLeft':
      case 'ArrowRight': {
        const forward = (event.key === 'ArrowRight') !== event.currentTarget.matches(':dir(rtl)');
        next = sparkLevel + (forward ? 1 : -1);
        break;
      }
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (dragPosition === null) selectPosition(next);
  }

  function handleNativeSliderChange(event: FormEvent<HTMLDivElement>) {
    if (!(event.target instanceof HTMLInputElement) || event.target.type !== 'range') return;
    // Assistive technologies can adjust the hidden range without a key event.
    event.stopPropagation();
    const position = event.target.valueAsNumber;
    const delta = position - sparkLevel;
    if (!disabled && dragPosition === null && Number.isFinite(position) && delta !== 0) {
      selectPosition(Math.abs(delta) < 1 ? sparkLevel + Math.sign(delta) : position);
    }
  }

  return <>
    <div className="effort-summary"><span className="effort-symbol"><Brain size="1.375rem" /></span><div><strong>{t('effort.summary', { label: effort?.label || (allowCustom ? t('effort.custom') : displayed) })}</strong><p>{effort?.description || displayed}</p></div></div>
    <div className="effort-scale" style={{ '--effort-count': Math.max(1, levels.length) } as CSSProperties}>
      {/* The wrapper carries the level so composer.css can scale the track's spark field with it. */}
      {levels.length > 1 && singleRow && <div className="effort-slider" data-at-max={atMax || undefined} data-sliding={dragPosition !== null || undefined}
        style={{ '--effort-level': String(sparkLevel) } as CSSProperties}
        onKeyDownCapture={handleSliderKey} onChangeCapture={handleNativeSliderChange}
        onPointerDownCapture={event => { if (event.isPrimary) cancelDrag.current = false; }}
        onPointerCancelCapture={event => { if (event.isPrimary) { cancelDrag.current = true; setDragPosition(null); } }}>
        <Slider aria-label={t('effort.aria')} className="effort-range" size="sm" minValue={0} maxValue={lastIndex} step={pointerStep} value={dragPosition ?? sparkLevel} isDisabled={disabled}
          onChange={position => { if (!disabled && !cancelDrag.current) setDragPosition(sliderPosition(position)); }}
          onChangeEnd={position => { if (!disabled && !cancelDrag.current) selectPosition(sliderPosition(position)); }} />
      </div>}
      <div className={`effort-levels${singleRow ? '' : ' effort-levels-wrap'}`}>{levels.map(level => <button key={level.value} disabled={disabled} aria-label={t('effort.levelAria', { label: level.label })} aria-pressed={level.value === displayed} onClick={() => { void commit(level.value); }}>{level.label}</button>)}</div>
    </div>
    {allowCustom && <form className="custom-effort" onSubmit={event => { event.preventDefault(); if (custom.trim()) { void commit(custom.trim()); onClose(); } }}><Input size="sm" variant="bordered" aria-label={t('effort.customAria')} placeholder={t('effort.customPlaceholder')} maxLength={24} value={custom} onValueChange={setCustom} isDisabled={disabled} /><Button size="sm" variant="flat" type="submit" isDisabled={disabled || !custom.trim()}>{t('effort.apply')}</Button></form>}
  </>;
}
