import { useRef, useState } from 'react';
import { Button, Input, Slider } from '@nextui-org/react';
import { Brain } from 'lucide-react';
import { effortLevels } from '../composer';

type Props = {
  value: string;
  disabled: boolean;
  onCommit: (value: string) => void | Promise<void>;
  onClose: () => void;
};

export default function ReasoningControl({ value, disabled, onCommit, onClose }: Props) {
  // Keep pointer updates inside this small control, independent of network saves
  // and the conversation tree. Only a completed gesture persists the selection.
  const [preview, setPreview] = useState<string | null>(null);
  const [custom, setCustom] = useState(() => effortLevels.some(level => level.value === value) ? '' : value);
  const revision = useRef(0);
  const pending = useRef(0);
  const displayed = preview ?? value;
  const index = effortLevels.findIndex(level => level.value === displayed);
  const effort = effortLevels[index];
  const levelAt = (position: number | number[]) => effortLevels[Array.isArray(position) ? position[0] : position].value;

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
    <div className="effort-summary"><span className="effort-symbol"><Brain size="1.375rem" /></span><div><strong>{effort?.label || '自定义'}强度</strong><p>{effort?.description || displayed}</p></div></div>
    <Slider aria-label="推理强度" size="sm" minValue={0} maxValue={5} step={1} value={Math.max(0, index)} isDisabled={disabled}
      onChange={position => { revision.current++; setPreview(levelAt(position)); setCustom(''); }}
      onChangeEnd={position => { void commit(levelAt(position)); }} />
    <div className="effort-levels">{effortLevels.map(level => <button key={level.value} disabled={disabled} aria-label={`推理强度：${level.label}`} aria-pressed={level.value === displayed} onClick={() => { void commit(level.value); }}>{level.label}</button>)}</div>
    <form className="custom-effort" onSubmit={event => { event.preventDefault(); if (custom.trim()) { void commit(custom.trim()); onClose(); } }}><Input size="sm" variant="bordered" aria-label="自定义推理强度" placeholder="自定义值，如 xhigh" maxLength={24} value={custom} onValueChange={setCustom} isDisabled={disabled} /><Button size="sm" variant="flat" type="submit" isDisabled={disabled || !custom.trim()}>应用</Button></form>
  </>;
}
