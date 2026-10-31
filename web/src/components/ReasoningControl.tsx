import { useRef, useState, type CSSProperties } from 'react';
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
};

export default function ReasoningControl({ value, disabled, onCommit, onClose, levels = effortLevels, allowCustom = true }: Props) {
  // Keep pointer updates inside this small control, independent of network saves
  // and the conversation tree. Only a completed gesture persists the selection.
  const [preview, setPreview] = useState<string | null>(null);
  const [custom, setCustom] = useState(() => allowCustom && levels.some(level => level.value === value) ? '' : allowCustom ? value : '');
  const revision = useRef(0);
  const pending = useRef(0);
  const displayed = preview ?? value;
  const index = levels.findIndex(level => level.value === displayed);
  const effort = levels[index];
  // A custom (off-scale) value parks the knob at 0, so the track's spark field stays calm.
  const sparkLevel = Math.max(0, index);
  const levelAt = (position: number | number[]) => levels[Array.isArray(position) ? position[0] : position].value;

  async function commit(next: string) {
    const current = ++revision.current;
    setCustom('');
    if (next === value && pending.current === 0) { setPreview(null); return; }
    setPreview(next);
    pending.current++;
    try { await onCommit(next); }
    finally {
      pending.current--;
      // An earlier response must not interrupt a newer drag or pending save.
      if (revision.current === current) setPreview(null);
    }
  }

  return <>
    <div className="effort-summary"><span className="effort-symbol"><Brain size="1.375rem" /></span><div><strong>{effort?.label || (allowCustom ? '自定义' : displayed)}强度</strong><p>{effort?.description || displayed}</p></div></div>
    <div className="effort-scale" style={{ '--effort-count': Math.max(1, levels.length) } as CSSProperties}>
      {/* The wrapper carries the level so composer.css can scale the track's spark field with it. */}
      <div className="effort-slider" style={{ '--effort-level': String(sparkLevel) } as CSSProperties}>
        <Slider aria-label="推理强度" className="effort-range" size="sm" minValue={0} maxValue={Math.max(0, levels.length - 1)} step={1} value={sparkLevel} isDisabled={disabled}
          onChange={position => { revision.current++; setPreview(levelAt(position)); setCustom(''); }}
          onChangeEnd={position => { void commit(levelAt(position)); }} />
      </div>
      <div className="effort-levels">{levels.map(level => <button key={level.value} disabled={disabled} aria-label={`推理强度：${level.label}`} aria-pressed={level.value === displayed} onClick={() => { void commit(level.value); }}>{level.label}</button>)}</div>
    </div>
    {allowCustom && <form className="custom-effort" onSubmit={event => { event.preventDefault(); if (custom.trim()) { void commit(custom.trim()); onClose(); } }}><Input size="sm" variant="bordered" aria-label="自定义推理强度" placeholder="自定义值，如 xhigh" maxLength={24} value={custom} onValueChange={setCustom} isDisabled={disabled} /><Button size="sm" variant="flat" type="submit" isDisabled={disabled || !custom.trim()}>应用</Button></form>}
  </>;
}
